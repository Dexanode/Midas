/**
 * Tool executor — routes LLM tool calls to actual implementations.
 * Runs in DRY_RUN mode when DRY_RUN=true (no real orders).
 */
import { log } from "../logger.js";
import * as mt5 from "../bridge/bridge.js";
import { config } from "../config.js";
import { getRecentDecisions, getPerformanceSummary } from "../decision-log.js";
import { getLessons, addLesson, evolveThresholds } from "../lessons.js";

const DRY_RUN = process.env.DRY_RUN === "true";

/**
 * Execute a single tool call and return the result.
 */
export async function executeTool(toolName, args) {
  log("agent", `Tool call: ${toolName}(${JSON.stringify(args).slice(0, 200)})`);

  switch (toolName) {

    // ── Market Data ──────────────────────────────────────────
    case "get_ohlcv": {
      const symbol = args.symbol || config.symbol || "XAUUSD";
      const timeframe = args.timeframe || config.timeframe || "M5";
      const bars = args.bars || 100;
      const result = await mt5.getOHLCV(symbol, timeframe, bars);
      if (!result.ok) return JSON.stringify(result);
      // Return compact: latest price + summary stats
      const candles = result.candles;
      const latest = candles[candles.length - 1];
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const closes = candles.map(c => c.close);
      const volumes = candles.map(c => c.tick_volume);

      // Simple ATR (14 period)
      const atr = calcATR(candles, 14);
      // SMA 20, 50
      const sma20 = calcSMA(closes, 20);
      const sma50 = calcSMA(closes, Math.min(50, closes.length));

      return JSON.stringify({
        symbol, timeframe, bars: candles.length,
        latest: {
          time: latest.time, open: latest.open, high: latest.high,
          low: latest.low, close: latest.close, spread: latest.spread,
        },
        summary: {
          period_high: Math.max(...highs).toFixed(2),
          period_low: Math.min(...lows).toFixed(2),
          avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
          atr_14: atr.toFixed(2),
          sma_20: sma20?.toFixed(2) || "N/A",
          sma_50: sma50?.toFixed(2) || "N/A",
          trend: closes[closes.length - 1] > closes[0] ? "bullish" : "bearish",
        },
        candles: candles.slice(-10), // last 10 candles for visual check
      });
    }

    case "get_spread": {
      const symbol = args.symbol || "XAUUSD";
      const result = await mt5.getSpread(symbol);
      return JSON.stringify(result);
    }

    // ── Account & Positions ──────────────────────────────────
    case "get_balance": {
      const result = await mt5.getBalance();
      if (!result.ok) return JSON.stringify(result);
      return JSON.stringify({
        balance: result.balance,
        equity: result.equity,
        margin: result.margin,
        free_margin: result.free_margin,
        floating_pnl: result.profit,
        margin_level: result.margin > 0 ? ((result.equity / result.margin) * 100).toFixed(1) + "%" : "N/A",
      });
    }

    case "get_positions": {
      const result = await mt5.getPositions();
      return JSON.stringify(result);
    }

    // ── Order Execution ──────────────────────────────────────
    case "open_order": {
      if (DRY_RUN) {
        log("trade", `[DRY RUN] Would open ${args.type} ${args.volume} lot ${args.symbol} SL=${args.sl} TP=${args.tp}`);
        return JSON.stringify({
          ok: true, dry_run: true,
          message: `[DRY RUN] Would open ${args.type} ${args.volume} lot ${args.symbol} @ SL:${args.sl} TP:${args.tp}`,
        });
      }
      const result = await mt5.openOrder(args);
      if (result.ok) {
        log("trade", `✅ OPENED ${args.symbol} ${args.type} ${args.volume}lot @ ${result.price} | Ticket: ${result.ticket}`);
      }
      return JSON.stringify(result);
    }

    case "close_position": {
      const { ticket, reason } = args;
      if (DRY_RUN) {
        log("trade", `[DRY RUN] Would close position ${ticket} — ${reason || "no reason"}`);
        return JSON.stringify({
          ok: true, dry_run: true,
          message: `[DRY RUN] Would close ticket ${ticket} — ${reason || "no reason"}`,
        });
      }
      const result = await mt5.closePosition(ticket);
      if (result.ok) {
        log("trade", `❌ CLOSED ${result.symbol} ticket ${ticket} @ ${result.close_price} | PnL: ${result.profit}`);
      }
      return JSON.stringify(result);
    }

    case "modify_position": {
      const { ticket, sl, tp } = args;
      if (DRY_RUN) {
        log("trade", `[DRY RUN] Would modify ticket ${ticket} SL→${sl || "unchanged"} TP→${tp || "unchanged"}`);
        return JSON.stringify({ ok: true, dry_run: true, ticket, sl, tp });
      }
      const result = await mt5.modifyPosition(ticket, sl, tp);
      return JSON.stringify(result);
    }

    // ── Analysis ─────────────────────────────────────────────
    case "get_trade_journal": {
      const limit = args.limit || 10;
      const decisions = getRecentDecisions(limit);
      return JSON.stringify({ count: decisions.length, decisions });
    }

    case "get_performance": {
      const summary = getPerformanceSummary();
      return JSON.stringify(summary);
    }

    case "update_config": {
      const { key, value } = args;
      let parsed;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      applyConfigUpdate(key, parsed);
      return JSON.stringify({ ok: true, key, value: parsed });
    }

    // ── Lessons & Learning ────────────────────────────────────
    case "get_lessons": {
      const limit = args.limit || 20;
      const result = getLessons(limit);
      // Filter by outcome if requested
      if (args.outcome && args.outcome !== "all") {
        result.lessons = result.lessons.filter(l => l.outcome === args.outcome);
      }
      return JSON.stringify(result);
    }

    case "add_lesson": {
      const lesson = addLesson({
        rule: args.rule,
        outcome: args.outcome || "neutral",
        context: args.context || "",
        tags: args.tags || [],
        avoid: args.avoid,
        seek: args.seek,
      });
      return JSON.stringify(lesson ? { ok: true, lesson } : { ok: false, error: "Duplicate or invalid lesson" });
    }

    case "evolve_thresholds": {
      const result = evolveThresholds();
      return JSON.stringify(result);
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` });
  }
}

// ─── Simple TA helpers (run locally, no MT5 needed) ──────────

function calcSMA(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / period;
}

/** Helper: safely apply config update with dot notation */
function applyConfigUpdate(key, value) {
  const cfgPath = key.split(".");
  let obj = config;
  for (let i = 0; i < cfgPath.length - 1; i++) {
    if (!obj[cfgPath[i]]) obj[cfgPath[i]] = {};
    obj = obj[cfgPath[i]];
  }
  obj[cfgPath[cfgPath.length - 1]] = value;
}
