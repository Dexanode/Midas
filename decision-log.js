import fs from "fs";
import { log } from "./logger.js";

const JOURNAL_FILE = "./trade-journal.json";
const MAX_ENTRIES = 200;

function load() {
  if (!fs.existsSync(JOURNAL_FILE)) return { entries: [] };
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); }
  catch (e) { log("warn", `Bad trade-journal.json: ${e.message}`); return { entries: [] }; }
}

function save(data) {
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2));
}

function s(val, maxLen = 280) {
  if (val == null) return null;
  return String(val).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

/**
 * Append a trade decision to the journal.
 * @param {Object} entry
 * @param {string} entry.type - "entry" | "exit" | "skip" | "modify"
 * @param {string} entry.signal - The signal that triggered this
 * @param {string} entry.summary - One-line summary
 * @param {string} entry.reason - LLM reasoning for the decision
 * @param {string[]} entry.risks - Key risks considered
 * @param {string[]} entry.rejected - Alternatives rejected and why
 * @param {Object} entry.metrics - Entry/exit metrics (price, pips, R:R, etc.)
 */
export function appendDecision(entry) {
  const data = load();
  const decision = {
    id: `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    signal: s(entry.signal, 120),
    summary: s(entry.summary),
    reason: s(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map(r => s(r, 140)).filter(Boolean).slice(0, 6) : [],
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map(r => s(r, 180)).filter(Boolean).slice(0, 8) : [],
    metrics: entry.metrics || {},
  };
  data.entries.unshift(decision);
  data.entries = data.entries.slice(0, MAX_ENTRIES);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10) {
  return load().entries.slice(0, limit);
}

export function getDecisionSummary(limit = 6) {
  const entries = getRecentDecisions(limit);
  if (!entries.length) return "No recent trade decisions yet.";
  return entries.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.type.toUpperCase()}] ${d.summary || "unnamed trade"}`,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}

/**
 * After a trade closes, record full result for learning.
 */
export function recordClosedTrade(tradeData) {
  const data = load();
  const closed = {
    id: `cls_${Date.now()}`,
    closedAt: new Date().toISOString(),
    entryPrice: tradeData.entryPrice,
    exitPrice: tradeData.exitPrice,
    direction: tradeData.direction,
    pips: tradeData.pips,
    profitLoss: tradeData.profitLoss,
    heldMinutes: tradeData.heldMinutes,
    signal: s(tradeData.signal),
    tags: tradeData.tags || [],
    lessons: s(tradeData.lessons, 500),
  };
  data.entries.unshift(closed);
  data.entries = data.entries.slice(0, MAX_ENTRIES);
  save(data);
  return closed;
}

export function getPerformanceSummary() {
  const entries = load().entries;
  const closed = entries.filter(e => e.closedAt);
  if (!closed.length) return { totalTrades: 0, winRate: 0, totalPips: 0, totalPnL: 0 };
  
  const wins = closed.filter(e => e.pips > 0);
  const totalPips = closed.reduce((s, e) => s + (e.pips || 0), 0);
  const totalPnL = closed.reduce((s, e) => s + (e.profitLoss || 0), 0);
  
  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRate: ((wins.length / closed.length) * 100).toFixed(1) + "%",
    totalPips: totalPips.toFixed(1),
    totalPnL: totalPnL.toFixed(2),
    avgPips: (totalPips / closed.length).toFixed(1),
    bestTrade: Math.max(...closed.map(e => e.pips || 0)).toFixed(1),
    worstTrade: Math.min(...closed.map(e => e.pips || 0)).toFixed(1),
  };
}
