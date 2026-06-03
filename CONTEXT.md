# Midas — Architecture & Flow

> Autonomous XAU/USD trading agent for Valetax (MT5), powered by LLMs via OpenRouter.
> Inspired by [Meridian](https://github.com/yunus-0x/meridian) architecture.
> **Status:** Skeleton ready, waiting for trading logic from Dexa's friend.

---

## 📁 Project Structure

```
midas/
├── index.js              # Main entry: cron scheduler + REPL
├── cli.js                # CLI for direct commands
├── agent.js              # ReAct agent loop (core engine)
├── prompt.js             # System prompt builder per role
├── config.js             # Config loader + runtime updates
├── logger.js             # Simple timestamped logger
├── decision-log.js       # Trade journal + performance stats
├── lessons.js            # Learning system (extract, store, inject, evolve)
├── state.js              # Position tracker + risk/emergency state
├── bridge/
│   ├── mt5_bridge.py     # Python MT5 JSON-RPC subprocess
│   └── bridge.js         # Node.js client to Python bridge
├── tools/
│   ├── definitions.js    # OpenAI tool definitions
│   └── executor.js       # Tool execution + TA helpers
├── .env                  # API keys, MT5 creds (gitignored)
├── user-config.json      # Trading parameters (editable)
└── package.json
```

---

## 🧠 Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    USER / REPL / CLI                      │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   index.js (Main)                         │
│  ┌─────────────────┐  ┌─────────────────┐               │
│  │  Cron Scheduler  │  │  REPL Interface │               │
│  │  - Screening     │  │  - /status      │               │
│  │    (every 15m)   │  │  - /screen      │               │
│  │  - Management    │  │  - /manage      │               │
│  │    (every 5m)    │  │  - /lessons     │               │
│  └────────┬─────────┘  │  - /evolve     │               │
│           │             │  - /stop        │               │
│           │             └────────┬────────┘               │
│           │                      │                        │
│  ┌────────▼──────────────────────▼─────────┐             │
│  │           agent.js (ReAct Loop)          │             │
│  │  System Prompt → LLM → Tool Call → ... │             │
│  │  (max 15 steps per cycle)               │             │
│  └────────┬────────────────────┬───────────┘             │
└───────────┼────────────────────┼─────────────────────────┘
            │                    │
    ┌───────▼───────┐    ┌───────▼───────┐
    │   prompt.js   │    │    LLM        │
    │  Build SOP    │    │  (OpenRouter)  │
    │  per role     │    └───────┬───────┘
    └───────────────┘            │
                                 │ Tool calls
    ┌────────────────────────────▼──────────────────────────┐
    │                tools/executor.js                       │
    │  Routes to: MT5 Bridge | Journal | Lessons | Config   │
    └────────────────────────────┬──────────────────────────┘
                                 │
    ┌────────────────────────────▼──────────────────────────┐
    │                bridge/bridge.js                        │
    │  Node.js ↔ Python subprocess (JSON-line RPC)          │
    └────────────────────────────┬──────────────────────────┘
                                 │
    ┌────────────────────────────▼──────────────────────────┐
    │              bridge/mt5_bridge.py                      │
    │  MetaTrader5 Python API → Valetax Server              │
    │  - get_ohlcv, get_balance, get_positions               │
    │  - open_order, close_position, modify_position         │
    └───────────────────────────────────────────────────────┘
```

---

## 🔄 Data Flow: One Full Cycle

### Screening Cycle (cari setup entry)

```
1. Cron triggers runScreeningCycle()
2. agent.js dipanggil dengan goal SCREENER
3. prompt.js builds system prompt:
   - Balance & positions live
   - Screening rules (R:R, spread, session, ATR)
   - Lessons injected (pinned + relevant)
   - Recent decisions + performance
4. LLM reasons → calls tools:
   - get_ohlcv(H1), get_ohlcv(M15), get_ohlcv(M5)
   - get_spread(), get_balance(), get_positions()
   - get_lessons() → recall past patterns
5. LLM decides:
   - FOUND SETUP → open_order(symbol, type, volume, sl, tp)
   - NO SETUP → skip with reasoning
6. Decision logged to trade-journal.json
7. setLastScreening() updates state
```

### Management Cycle (pantau posisi open)

```
1. Cron triggers runManagementCycle()
2. getPositions() → semua posisi open
3. agent.js dipanggil dengan goal + position data
4. prompt.js builds lean MANAGER prompt:
   - Balance
   - Management rules (breakeven, trailing, partial close)
   - Lessons injected
5. LLM reasons → calls tools:
   - get_position_pnl? (via get_positions snapshots)
   - modify_position(ticket, sl, tp) → breakeven/trail
   - close_position(ticket, reason) → exit bad trades
6. Decision logged
```

### Trade Close → Learning Pipeline

```
1. close_position() executed via MT5
2. recordClosedTrade() → saves to trade-journal.json
3. extractLessonFromTrade() triggered:
   - LLM analyzes: win or loss? why?
   - Extracts: rule, context, tags, seek, avoid
4. addLesson() → saves to lessons.json (dedup'd)
5. Auto-pins big wins (>200 pips)
6. Next cycle: lessons injected into prompt via getLessonsForPrompt()
```

### Evolution Pipeline

```
1. After 5+ closed trades
2. evolveThresholds() triggered (via /evolve or cron):
   - Calculates win rate
   - Analyzes loss patterns per tag (Asia, NY, etc.)
   - Adjusts:
     - riskPerTradePct (↑ if WR≥60%, ↓ if WR<40%)
     - minRiskRewardRatio (↑ if session losses high)
3. Changes saved to user-config.json
4. Logged to lessons.json.lastEvolution
```

---

## 🎭 Agent Roles

| Role | Prompt | Tools | Purpose |
|------|--------|-------|---------|
| **SCREENER** | Full analysis rules, multi-TF checklist | OHLCV, spread, balance, positions, open_order, get_lessons | Find & execute entries |
| **MANAGER** | Lean, mechanical rules | positions, close, modify, get_lessons | Monitor & manage open trades |
| **GENERAL** | Free-form chat, user commands | All non-admin tools | REPL, CLI, manual ops |

---

## 🛠️ Available Tools

| Tool | Role Access | Description |
|------|-------------|-------------|
| `get_ohlcv` | All | Fetch OHLCV bars + ATR, SMA |
| `get_spread` | All | Current bid/ask spread in pips |
| `get_balance` | All | Account equity, margin, PnL |
| `get_positions` | All | Open positions list |
| `open_order` | Screener, General | Execute market order |
| `close_position` | Manager, General | Close position by ticket |
| `modify_position` | Manager, General | Change SL/TP |
| `get_trade_journal` | All | Recent decisions + results |
| `get_performance` | All | Win rate, total pips, PnL |
| `get_lessons` | All | Learned patterns |
| `add_lesson` | All | Manual lesson entry |
| `evolve_thresholds` | General | Auto-adjust parameters |
| `update_config` | All | Runtime config changes |

---

## 📊 Data Files

| File | Purpose |
|------|---------|
| `trade-journal.json` | Every entry/exit/skip decision + closed trade results |
| `lessons.json` | Learned patterns: rules, outcomes, tags, seek/avoid |
| `state.json` | Runtime state: tracked positions, daily PnL, emergency stop |
| `user-config.json` | All trading parameters (editable at runtime) |
| `decision-log.json` | (Legacy, from Meridian) — merged into trade-journal.json |

---

## ⚙️ Key Configuration

### Screening Parameters
```json
{
  "maxPositions": 3,          // Max concurrent open positions
  "riskPerTradePct": 1.0,     // % of balance risked per trade
  "minRiskRewardRatio": 1.5,  // Minimum R:R
  "maxSpreadPips": 35,        // Max spread before skip entry
  "minATR": 200,              // Min ATR(14) for active market
  "allowedSessions": ["London", "New York"],
  "avoidNewsMinutes": 30      // No entry before high-impact news
}
```

### Management Parameters
```json
{
  "breakevenAfterPips": 100,  // Move SL to entry+10 after +100 pips
  "breakevenLockPips": 10,
  "partialClosePct": 50,      // Close 50% at target
  "partialCloseAfterPips": 80,
  "trailingStopPips": 0,      // 0 = disabled
  "maxDrawdownPct": -5,       // Emergency stop level
  "outOfRangeWaitMinutes": 60
}
```

### Risk Limits
```json
{
  "maxDailyLossPct": 3.0,     // Stop all trading if hit
  "maxWeeklyLossPct": 6.0,
  "maxConsecutiveLosses": 5   // Stop after N losses in a row
}
```

---

## 🚀 Startup & Modes

### Dry Run (safe testing)
```bash
npm run dev
# or: DRY_RUN=true node index.js
```
- No real orders
- MT5 bridge optional
- Full ReAct loop + journal + lessons still work

### Live Mode
```bash
# 1. Edit .env: set OPENROUTER_API_KEY + MT5_LOGIN/PASSWORD/SERVER + DRY_RUN=false
# 2. pip install MetaTrader5
# 3. Open MT5 terminal, login to Valetax
npm start
```

### CLI Commands
```bash
midas balance          # Account balance
midas positions         # Open positions
midas screen [--dry-run]  # AI screening (analysis only)
midas manage [--dry-run]  # AI management cycle
midas ohlcv [symbol] --tf=M5 --bars=100
midas performance       # Trade stats
midas lessons           # List all lessons
midas lessons add "..." # Manual lesson
midas lessons pin <id>  # Pin/unpin lesson
midas evolve            # Auto-evolve thresholds
midas config get        # Show config
midas config set k v    # Update config
midas start             # Autonomous mode
```

### REPL Commands (interactive)
```
/status    → Balance + positions
/screen    → Manual screening cycle
/manage    → Manual management cycle
/lessons   → Show lesson library
/evolve    → Trigger threshold evolution
/stop      → Graceful shutdown
<text>     → Free-form chat with LLM agent
```

---

## 🧩 Extending the System

### Adding a new tool:
1. Add to `tools/definitions.js` — OpenAI function schema
2. Add case in `tools/executor.js` — implementation
3. Add to role subsets (SCREENER/MANAGER/GENERAL)
4. If MT5-dependent → add method in `bridge/mt5_bridge.py` + `bridge/bridge.js`

### Adding trading logic (when friend sends):
1. **Rules** → edit `prompt.js` in SCREENER/MANAGER sections
2. **New indicators** → add calculation in `tools/executor.js` TA helpers
3. **New data sources** → add to Python bridge or as web_fetch tool
4. **New conditions** → add to `config.js` defaults + `user-config.json`

### Models:
- Edit `user-config.json` → `llm.screeningModel`, `llm.managementModel`, `llm.generalModel`
- Or override at runtime: `midas config set llm.screeningModel "anthropic/claude-opus-4-5"`
- Any OpenRouter model supported

---

## ⚠️ Current Limitations / TODO

1. **MT5 must run 24/7** on the same machine (or bridge on VPS)
2. **News feed** — stub only, needs external API (ForexFactory/FXStreet)
3. **Telegram notifications** — not yet implemented (can add like Meridian)
4. **Multi-pair** — currently XAUUSD only
5. **Backtesting** — no historical simulation yet
6. **Trading logic** — currently generic rules, waiting for friend's strategy

---

*Generated 2026-06-03 by Exa 🦾*
