/**
 * OpenAI-compatible tool definitions for the Forex LLM Agent.
 * All tools that interact with MT5 go through the Python bridge.
 */

export const tools = [
  // ═══════════════════════════════════════════
  //  CONFLUENCE SCANNER (Labuu Method)
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "scan_confluence_zones",
      description: `Run the Labuu confluence scanner on XAUUSD. Detects H4 zones (S/R/SBR/RBS) and H1 entry signals (Pinbar/Engulfing/Confirmed).
Returns a structured report with ALL detected zones, which zones have valid H1 signals, and ready-to-execute order parameters.
Use this at the start of EVERY screening cycle. This is the primary data source for trade decisions.`,
      parameters: {
        type: "object",
        properties: {
          slPips: { type: "number", description: "Override SL in pips (default 150)" },
          tpPips: { type: "number", description: "Override TP in pips (default 300)" },
          lotSize: { type: "number", description: "Override lot size (default 0.01)" }
        }
      }
    }
  },
  // ═══════════════════════════════════════════
  //  MARKET DATA
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_ohlcv",
      description: `Get OHLCV candlestick data from MT5 for a symbol.
Returns open, high, low, close, tick_volume, spread for each bar.
Use this to analyze price action, identify support/resistance, and evaluate trade setups.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol. Default: XAUUSD" },
          timeframe: { type: "string", enum: ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"], description: "Candle timeframe" },
          bars: { type: "number", description: "Number of bars to fetch (max 5000). Default 100." }
        },
        required: ["timeframe"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_spread",
      description: `Get current bid/ask and spread in pips for a symbol.
Use before opening trades to ensure spread is acceptable.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol. Default: XAUUSD" }
        }
      }
    }
  },

  // ═══════════════════════════════════════════
  //  ACCOUNT & POSITIONS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_balance",
      description: `Get current account balance, equity, margin, free margin, and floating PnL.
ALWAYS call this before opening a position to check available margin.`,
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: `Get all currently open positions.
Returns ticket, symbol, type (BUY/SELL), volume, open_price, current_price, SL, TP, profit, pnl_pips.
Use at the start of every management cycle.`,
      parameters: { type: "object", properties: {} }
    }
  },

  // ═══════════════════════════════════════════
  //  ORDER EXECUTION
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "open_order",
      description: `Open a new market order.
WARNING: This executes a REAL trade on the live account. Check DRY_RUN mode.
Before calling: verify balance, spread, and that no duplicate positions exist for the same setup.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol (XAUUSD)" },
          type: { type: "string", enum: ["BUY", "SELL"], description: "Order direction" },
          volume: { type: "number", description: "Lot size (e.g. 0.01)" },
          sl: { type: "number", description: "Stop Loss price" },
          tp: { type: "number", description: "Take Profit price" },
          comment: { type: "string", description: "Order comment / signal name" }
        },
        required: ["symbol", "type", "volume"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_position",
      description: `Close an open position by ticket number.
WARNING: This executes a REAL trade. Cannot be undone.`,
      parameters: {
        type: "object",
        properties: {
          ticket: { type: "number", description: "Position ticket number from get_positions" },
          reason: { type: "string", description: "Reason for closing (for journal)" }
        },
        required: ["ticket"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "modify_position",
      description: `Modify Stop Loss and/or Take Profit of an open position.
Use for trailing stops, breakeven moves, or adjusting targets.`,
      parameters: {
        type: "object",
        properties: {
          ticket: { type: "number", description: "Position ticket number" },
          sl: { type: "number", description: "New Stop Loss price (0 to leave unchanged)" },
          tp: { type: "number", description: "New Take Profit price (0 to leave unchanged)" }
        },
        required: ["ticket"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  ANALYSIS & RESEARCH
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_trade_journal",
      description: `Get recent trade decisions and closed trade performance.
Use to review past decisions, analyze win/loss patterns, and avoid repeating mistakes.`,
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of entries. Default 10." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_performance",
      description: `Get overall trading performance summary: total trades, win rate, total pips, total PnL, best/worst trades.
Use to evaluate how the strategy is performing.`,
      parameters: { type: "object", properties: {} }
    }
  },
  // ═══════════════════════════════════════════
  //  LESSONS & LEARNING
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_lessons",
      description: `Get the agent's lesson library — rules learned from past trades.
Use this to recall what worked and what didn't before making a decision.
Returns lessons with outcome (win/loss), context, and actionable SEEK/AVOID patterns.`,
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max lessons to return. Default 20." },
          outcome: { type: "string", enum: ["win", "loss", "all"], description: "Filter by outcome. Default: all" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_lesson",
      description: `Add a new lesson to the agent's knowledge base manually.
Use after discovering a new pattern or insight from a trade.`,
      parameters: {
        type: "object",
        properties: {
          rule: { type: "string", description: "The lesson — one clear, actionable sentence" },
          outcome: { type: "string", enum: ["win", "loss", "neutral"], description: "What was the result" },
          context: { type: "string", description: "Market condition (e.g., 'London breakout')" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for filtering" },
          avoid: { type: "string", description: "What to avoid in the future" },
          seek: { type: "string", description: "What setup to look for" }
        },
        required: ["rule"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "evolve_thresholds",
      description: `Analyze all closed trades and evolve screening thresholds automatically.
Increases risk when win rate is high, decreases when low.
Requires 5+ closed trades. Returns what changed and why.`,
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "update_config",
      description: `Update agent configuration at runtime.
Can adjust risk parameters, intervals, thresholds, and model settings.`,
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Config key path (e.g. 'management.trailingStopPips', 'screening.riskPerTradePct')" },
          value: { type: "string", description: "New value (will be parsed as JSON/number when possible)" }
        },
        required: ["key", "value"]
      }
    }
  }
];

/** Tool subsets per agent role */
export const SCREENER_TOOLS = new Set([
  "scan_confluence_zones",
  "get_ohlcv", "get_spread", "get_balance", "get_positions",
  "open_order", "get_trade_journal", "get_performance", "update_config",
  "get_lessons", "add_lesson"
]);

export const MANAGER_TOOLS = new Set([
  "get_ohlcv", "get_spread", "get_balance", "get_positions",
  "close_position", "modify_position", "get_trade_journal", "get_performance",
  "get_lessons", "add_lesson"
]);

export const GENERAL_INTENT_ONLY = new Set([
  "update_config", "evolve_thresholds"
]);

/** Intent matching patterns for GENERAL role (REPL/chat) */
export const INTENT_PATTERNS = [
  { intent: "screening",  re: /\b(scan|screen|setup|signal|opportunity|find trade|analysis)\b/i },
  { intent: "management", re: /\b(manage|position|close|exit|modify|sl|tp|trail|breakeven)\b/i },
  { intent: "performance", re: /\b(performance|history|stats|win.?rate|pnl|how.?s it doing)\b/i },
  { intent: "config",     re: /\b(config|setting|threshold|update|change|set )\b/i },
  { intent: "balance",    re: /\b(balance|equity|margin|account)\b/i },
];

export function getToolsForRole(agentType) {
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  // GENERAL: all tools except config-only ones
  return tools.filter(t => !GENERAL_INTENT_ONLY.has(t.function.name));
}
