/**
 * Learning System — extracts, stores, and injects lessons from closed trades.
 * Adapted from Meridian's lessons.js architecture.
 *
 * Flow:
 *   Trade closes → recordClosedTrade() triggers extractLesson()
 *   → LLM reflects on the result → lesson saved to lessons.json
 *   → Relevant lessons injected into future system prompts
 *   → Performance data feeds threshold evolution
 */
import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./decision-log.js";
import { config, saveConfig } from "./config.js";

const LESSONS_FILE = "./lessons.json";
const MAX_LESSONS = 200;

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], lastEvolution: null };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch (e) {
    log("warn", `Bad lessons.json: ${e.message}`);
    return { lessons: [], lastEvolution: null };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

function s(val, maxLen = 300) {
  if (val == null) return null;
  return String(val).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

/**
 * Add a new lesson to the knowledge base.
 *
 * @param {Object} params
 * @param {string} params.rule - The lesson learned (one clear sentence)
 * @param {string} params.outcome - "win" | "loss" | "neutral" | "manual"
 * @param {string} params.context - What market condition (e.g., "London breakout", "NY reversal")
 * @param {string[]} params.tags - Tags for filtering: trend, session, pattern, etc.
 * @param {boolean} params.pinned - Whether this lesson should always be injected
 * @param {string} params.role - "SCREENER" | "MANAGER" | null (applies to all)
 * @param {Object} params.metrics - Trade metrics that led to this lesson
 * @param {string} params.avoid - What to avoid doing (optional)
 * @param {string} params.seek - What to look for (optional)
 */
export function addLesson({
  rule,
  outcome = "neutral",
  context = "",
  tags = [],
  pinned = false,
  role = null,
  metrics = {},
  avoid = null,
  seek = null,
}) {
  const data = load();

  // Dedup: don't save near-identical rules
  const normalized = rule.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const exists = data.lessons.some(l =>
    l._norm === normalized || similarEnough(l.rule.toLowerCase(), rule.toLowerCase(), 0.8)
  );
  if (exists) {
    log("state", `Skipping duplicate lesson: ${rule.slice(0, 100)}`);
    return null;
  }

  const lesson = {
    id: `lsn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at: new Date().toISOString(),
    rule: s(rule),
    _norm: normalized,
    outcome,
    context: s(context, 150),
    tags,
    pinned,
    role,
    metrics,
    avoid: s(avoid, 200),
    seek: s(seek, 200),
    usage_count: 0,
    last_injected: null,
  };

  data.lessons.unshift(lesson);
  // Prune to max
  if (data.lessons.length > MAX_LESSONS) {
    // Remove least-used unpinned lessons first
    const unpinned = data.lessons.filter(l => !l.pinned).sort((a, b) => a.usage_count - b.usage_count);
    const toRemove = unpinned.slice(0, data.lessons.length - MAX_LESSONS);
    data.lessons = data.lessons.filter(l => !toRemove.includes(l));
  }
  save(data);
  log("state", `Lesson saved: ${rule.slice(0, 100)} [${outcome}]`);
  return lesson;
}

/**
 * Auto-extract a lesson from a closed trade using the agent itself.
 * Called after recordClosedTrade().
 *
 * @param {Object} closedTrade - Full trade result from decision-log
 * @param {Function} agentLoopFn - Reference to agentLoop for LLM extraction
 */
export async function extractLessonFromTrade(closedTrade, agentLoopFn) {
  const isWin = (closedTrade.pips || 0) > 0;
  const outcome = isWin ? "win" : "loss";

  // Skip tiny trades — not enough signal
  if (Math.abs(closedTrade.pips || 0) < 20) {
    log("state", `Trade too small for lesson extraction (${closedTrade.pips} pips)`);
    return null;
  }

  const tradeDesc = [
    `Direction: ${closedTrade.direction}`,
    `Entry: ${closedTrade.entryPrice}`,
    `Exit: ${closedTrade.exitPrice}`,
    `Result: ${closedTrade.pips} pips | $${closedTrade.profitLoss}`,
    `Duration: ${closedTrade.heldMinutes} min`,
    `Signal: ${closedTrade.signal || "unknown"}`,
    closedTrade.tags?.length ? `Tags: ${closedTrade.tags.join(", ")}` : "",
  ].filter(Boolean).join(" | ");

  const goal = `EXTRACT LESSON from this ${outcome.toUpperCase()} trade:

${tradeDesc}

Respond with EXACTLY this JSON format (no other text):
{
  "rule": "One clear, actionable lesson in English. Max 150 chars.",
  "context": "Market condition: e.g. 'London trend continuation', 'NY chop', 'Asia breakout'",
  "tags": ["tag1", "tag2"],
  "avoid": "What specific behavior or condition to avoid",
  "seek": "What specific setup or condition to look for next time"
}`;

  try {
    const rawReport = await agentLoopFn(goal, 4, [], "GENERAL");
    // Try to extract JSON from the response
    const jsonMatch = rawReport?.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log("state", "Lesson extraction: no JSON found in response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.rule) return null;

    return addLesson({
      rule: parsed.rule,
      outcome,
      context: parsed.context || "",
      tags: parsed.tags || [],
      pinned: isWin && Math.abs(closedTrade.pips) > 200, // Auto-pin big wins
      role: null,
      metrics: {
        pips: closedTrade.pips,
        profitLoss: closedTrade.profitLoss,
        duration: closedTrade.heldMinutes,
        signal: closedTrade.signal,
      },
      avoid: parsed.avoid,
      seek: parsed.seek,
    });
  } catch (e) {
    log("state", `Lesson extraction failed: ${e.message}`);
    return null;
  }
}

/**
 * Get lessons formatted for injection into system prompts.
 * Filters by role and limits to most relevant + pinned.
 *
 * @param {Object} options
 * @param {string} options.agentType - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} options.maxLessons - Max lessons to inject (default 12)
 * @returns {string} - Formatted lesson text for prompt
 */
export function getLessonsForPrompt({ agentType = null, maxLessons = 12 } = {}) {
  const data = load();
  let lessons = data.lessons;

  // Filter by role if specified
  if (agentType) {
    const roleFiltered = lessons.filter(l => !l.role || l.role === agentType);
    if (roleFiltered.length >= 4) lessons = roleFiltered;
  }

  if (lessons.length === 0) return null;

  // Priority: pinned first, then by usage_count, then recency
  const ranked = [...lessons].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (a.pinned && b.pinned) return b.usage_count - a.usage_count;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  const selected = ranked.slice(0, maxLessons);

  // Mark as injected
  const now = new Date().toISOString();
  for (const lesson of selected) {
    lesson.usage_count = (lesson.usage_count || 0) + 1;
    lesson.last_injected = now;
  }
  save(data);

  // Format
  const winCount = selected.filter(l => l.outcome === "win").length;
  const lossCount = selected.filter(l => l.outcome === "loss").length;

  const header = `Lessons learned (${selected.length} total: ${winCount} from wins, ${lossCount} from losses):`;
  const lines = selected.map((l, i) => {
    const icon = l.outcome === "win" ? "🟢" : l.outcome === "loss" ? "🔴" : "📝";
    const pinnedMark = l.pinned ? " [PINNED]" : "";
    const parts = [`${i + 1}. ${icon}${pinnedMark} ${l.rule}`];
    if (l.context) parts.push(`   Context: ${l.context}`);
    if (l.seek) parts.push(`   → SEEK: ${l.seek}`);
    if (l.avoid) parts.push(`   → AVOID: ${l.avoid}`);
    return parts.join("\n");
  });

  return header + "\n\n" + lines.join("\n");
}

/**
 * Add a lesson manually (from REPL or user command).
 */
export function addManualLesson(rule, outcome = "manual") {
  return addLesson({
    rule,
    outcome,
    context: "manual entry",
    tags: ["manual"],
    pinned: false,
    role: null,
  });
}

/**
 * Toggle pin status of a lesson by ID.
 */
export function togglePinLesson(lessonId) {
  const data = load();
  const lesson = data.lessons.find(l => l.id === lessonId);
  if (!lesson) return false;
  lesson.pinned = !lesson.pinned;
  save(data);
  return lesson.pinned;
}

/**
 * Get raw lessons list (for CLI / API use).
 */
export function getLessons(limit = 50) {
  const data = load();
  const lessons = data.lessons.slice(0, limit).map(l => ({
    id: l.id,
    rule: l.rule,
    outcome: l.outcome,
    context: l.context,
    tags: l.tags,
    pinned: l.pinned,
    role: l.role,
    usage_count: l.usage_count,
    created_at: l.created_at,
  }));
  return { total: data.lessons.length, lessons };
}

/**
 * Clear all lessons (dangerous, requires confirmation).
 */
export function clearLessons() {
  save({ lessons: [], lastEvolution: null });
  log("state", "All lessons cleared");
  return true;
}

// ═══════════════════════════════════════════
//  THRESHOLD EVOLUTION
// ═══════════════════════════════════════════

/**
 * Evolve screening thresholds based on closed trade data.
 * Analyzes win/loss patterns and suggests adjustments.
 * Requires at least 5 closed trades.
 *
 * @returns {Object} - { evolved: boolean, changes: object, rationale: string }
 */
export function evolveThresholds() {
  const perf = getPerformanceSummary();
  const closedTrades = load().lessons.filter(l => l.metrics?.pips != null);

  if (closedTrades.length < 5) {
    log("state", `Need 5+ closed trades for evolution (have ${closedTrades.length})`);
    return { evolved: false, changes: {}, rationale: "Not enough data — need 5+ closed trades." };
  }

  const wins = closedTrades.filter(t => t.outcome === "win");
  const losses = closedTrades.filter(t => t.outcome === "loss");
  const winRate = wins.length / closedTrades.length;

  const changes = {};
  const rationale = [];

  // ═══ Evolve risk parameters ═══
  if (winRate >= 0.6 && closedTrades.length >= 10) {
    // Doing well — slightly increase risk
    const currentRisk = config.screening?.riskPerTradePct || 1.0;
    const newRisk = Math.min(currentRisk * 1.1, 3.0);
    changes["screening.riskPerTradePct"] = Math.round(newRisk * 10) / 10;
    rationale.push(`Win rate ${(winRate*100).toFixed(0)}% — increasing risk to ${changes["screening.riskPerTradePct"]}%`);
  } else if (winRate < 0.4) {
    // Struggling — reduce risk
    const currentRisk = config.screening?.riskPerTradePct || 1.0;
    const newRisk = Math.max(currentRisk * 0.7, 0.3);
    changes["screening.riskPerTradePct"] = Math.round(newRisk * 10) / 10;
    rationale.push(`Win rate ${(winRate*100).toFixed(0)}% — reducing risk to ${changes["screening.riskPerTradePct"]}%`);
  }

  // ═══ Analyze loss patterns ═══
  const lossTags = {};
  for (const l of losses) {
    for (const tag of l.tags || []) {
      lossTags[tag] = (lossTags[tag] || 0) + 1;
    }
  }

  // If many losses in "Asia" session, tighten Asia criteria
  if (lossTags["asia"] >= 3) {
    changes["screening.minRiskRewardRatio"] = Math.min(
      (config.screening?.minRiskRewardRatio || 1.5) + 0.3, 3.0
    );
    rationale.push("High Asia losses — increasing min R:R requirement");
  }

  // ═══ Analyze win patterns ═══
  const winDurations = wins.map(w => w.metrics?.duration).filter(Boolean);
  const avgWinDuration = winDurations.length > 0
    ? winDurations.reduce((a, b) => a + b, 0) / winDurations.length
    : 0;

  if (avgWinDuration > 180 && (config.management?.partialCloseAfterPips || 0) === 0) {
    rationale.push(`Avg win duration ${avgWinDuration.toFixed(0)} min — consider enabling partial close for long holds`);
  }

  // Apply changes
  if (Object.keys(changes).length > 0) {
    for (const [key, value] of Object.entries(changes)) {
      saveConfig({ [key]: value });
    }

    const data = load();
    data.lastEvolution = {
      at: new Date().toISOString(),
      tradesAnalyzed: closedTrades.length,
      changes,
      rationale: rationale.join("; "),
    };
    save(data);

    log("state", `Thresholds evolved — ${rationale.join("; ")}`);
  }

  return {
    evolved: Object.keys(changes).length > 0,
    changes,
    rationale: rationale.join("; "),
  };
}

/**
 * Simple string similarity check for dedup.
 */
function similarEnough(a, b, threshold = 0.8) {
  if (!a || !b) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length < 10) return false;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return matches / shorter.length >= threshold;
}
