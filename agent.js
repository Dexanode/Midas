/**
 * Core ReAct agent loop for Forex LLM.
 * Adapted from Meridian's agent.js architecture.
 *
 * Flow: System Prompt → LLM Reason → Tool Call → Tool Result → Repeat
 */
import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools, getToolsForRole } from "./tools/definitions.js";
import { getBalance, getPositions } from "./bridge/bridge.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getDecisionSummary, getPerformanceSummary } from "./decision-log.js";
import { getLessonsForPrompt } from "./lessons.js";

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openai/gpt-oss-20b:free";

// Tools that should only be called ONCE per session (no retries)
const ONCE_PER_SESSION = new Set(["open_order", "close_position"]);
const NO_RETRY_TOOLS = new Set(["open_order"]);

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Run the ReAct agent loop.
 *
 * @param {string} goal - The task description
 * @param {number} maxSteps - Safety limit (default from config)
 * @param {Array} sessionHistory - Previous messages for continuity
 * @param {string} agentType - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {string|null} model - Override model
 * @param {Object} options - { onToolStart, onToolFinish, interactive }
 * @returns {string} - Final agent response
 */
export async function agentLoop(
  goal,
  maxSteps = config.llm?.maxSteps || 15,
  sessionHistory = [],
  agentType = "GENERAL",
  model = null,
  options = {}
) {
  // Build dynamic system prompt with live state
  const [balanceResult, positionsResult] = await Promise.all([
    getBalance().catch(() => null),
    getPositions().catch(() => null),
  ]);

  const balance = balanceResult?.ok ? {
    balance: balanceResult.balance,
    equity: balanceResult.equity,
    free_margin: balanceResult.free_margin,
    floating_pnl: balanceResult.profit,
  } : null;

  const positions = positionsResult?.ok ? {
    count: positionsResult.count,
    positions: positionsResult.positions,
  } : { count: 0, positions: [] };

  const stateSummary = getStateSummary();
  const decisionSummary = getDecisionSummary();
  const perfSummary = getPerformanceSummary();
  const lessons = getLessonsForPrompt({ agentType });

  const systemPrompt = buildSystemPrompt(
    agentType, balance, positions,
    stateSummary, decisionSummary, perfSummary, lessons
  );

  const roleTools = getToolsForRole(agentType);

  // Build messages
  let providerMode = "system";
  let messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  let firedOnce = new Set();
  let sawToolCall = false;
  let omitToolChoice = false;
  let emptyStreak = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps} [${agentType}]`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry logic for transient failures
      let attempt = 0;
      let response;
      while (attempt < 3) {
        try {
          const params = {
            model: activeModel,
            messages,
            tools: roleTools,
            tool_choice: omitToolChoice ? undefined : "auto",
            temperature: 0.3,
          };

          response = await client.chat.completions.create(params);
          break;
        } catch (e) {
          attempt++;
          const msg = String(e?.message || e);

          if (/invalid message role:\s*system/i.test(msg)) {
            // Provider doesn't support system role → embed in user message
            log("agent", "System role rejected, switching to user_embedded mode");
            providerMode = "user_embedded";
            messages = [
              {
                role: "user",
                content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
              },
              ...sessionHistory,
            ];
            continue; // retry with new format
          }

          if (/thinking mode does not support/i.test(msg) && /tool_choice/i.test(msg)) {
            log("agent", "Thinking mode incompatible with tool_choice, retrying without");
            omitToolChoice = true;
            continue;
          }

          if (/tool_choice/i.test(msg) && /required/i.test(msg)) {
            omitToolChoice = true;
            continue;
          }

          if (attempt >= 3) throw e;
          log("agent", `API error (attempt ${attempt}): ${msg.slice(0, 200)}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      const message = response.choices[0].message;
      const toolCalls = message.tool_calls || [];

      // No tool calls → agent is done, return final response
      if (toolCalls.length === 0) {
        const content = stripThink(message.content || "");

        if (!content.trim()) {
          emptyStreak++;
          if (emptyStreak >= 2) {
            log("agent", "Empty response streak, stopping");
            return "Decision: No action taken — insufficient data or confidence.";
          }
        }

        // If we expected tool use but got none, nudge once
        if (!sawToolCall && step === 0 && agentType !== "GENERAL") {
          messages.push({ role: "assistant", content: content || "(thinking)" });
          messages.push({ role: "user", content: "Use your tools to analyze the data and act. Do not just describe — execute." });
          continue;
        }

        return content || "No action taken.";
      }

      sawToolCall = true;
      emptyStreak = 0;

      // Record assistant message with tool calls
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: toolCalls,
      });

      // Execute each tool call
      for (const tc of toolCalls) {
        const fn = tc.function;
        let args = {};

        try {
          args = JSON.parse(jsonrepair(fn.arguments || "{}"));
        } catch {
          log("agent", `Bad JSON args from model for ${fn.name}: ${fn.arguments?.slice(0, 200)}`);
          args = {};
        }

        // Prevent retrying one-shot tools
        if (NO_RETRY_TOOLS.has(fn.name)) {
          if (firedOnce.has(fn.name)) {
            log("agent", `BLOCKED retry of ${fn.name}`);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: false, error: `${fn.name} already called this session — cannot retry. Move on.` }),
            });
            continue;
          }
          firedOnce.add(fn.name);
        }

        const result = await executeTool(fn.name, args);

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);
      return `Error: ${error.message}`;
    }
  }

  log("agent", `Max steps (${maxSteps}) reached — forcing exit`);
  return "Max steps reached without final decision. Review data and retry with a focused goal.";
}
