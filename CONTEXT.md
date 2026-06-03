# Midas — Architecture & Flow

> Autonomous XAU/USD trading agent for Valetax (MT5), powered by LLMs via OpenRouter.
> Inspired by [Meridian](https://github.com/yunus-0x/meridian) architecture.
> **Trading Logic:** Labuu Method — Confluence Scanner (H4 zones + H1 signals)

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
├── scanner/
│   └── labuu.js          # Labuu confluence scanner (H4 zones + H1 signals)
├── telegram.js           # Telegram bot integration
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

### Hybrid Flow (Opsi A — Token-Efficient)

```
┌─────────────────────────────────────────────────────────┐
│              CRON — Every 60 Seconds                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  scanner/labuu.js (CPU-only, FREE)                       │
│  ├─ Fetch H4 (100 bars) + H1 (200 bars) via MT5         │
│  ├─ Detect swing highs/lows (body-based, L2/R2)         │
│  ├─ Classify zones: S / R / SBR / RBS                   │
│  ├─ Merge nearby zones (≤50 pips)                       │
│  ├─ H1 signal scan: CONFIRMED / PINBAR / ENGULFING     │
│  └─ Build ready-to-execute order params                 │
│                                                          │
│  IF signal found:                                        │
│    → LLM Review (1 API call, ~500 tokens)               │
│    → Approve: open_order() with scanner params          │
│    → Reject: skip + log reason                          │
│                                                          │
│  IF no signal:                                           │
│    → Silent skip, no LLM call needed                    │
│                                                          │
└─────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────┐
│                MANAGEMENT — Every 5 Minutes               │
│  LLM reviews positions → modify SL/TP → trailing stop   │
│  Trailing: Labuu progressive steps (rule-based)         │
└─────────────────────────────────────────────────────────┘
```

### Full Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    USER / REPL / CLI                      │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   index.js (Main)                         │
│  ┌─────────────────┐  ┌─────────────────┐               │
│  │  Cron Scheduler  │  │  Telegram       │               │
│  │  - Screening     │  │  - /status      │               │
│  │    (every 1m)    │  │  - /positions   │               │
│  │  - Management    │  │  - /close       │               │
│  │    (every 5m)    │  │  - /screen      │               │
│  └────────┬─────────┘  │  - /manage      │               │
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

### Screening Cycle (Confluence Scanner + LLM Review)

```
1. Cron triggers runScreeningCycle() (every 60s)
2. scanner/labuu.js runs scanConfluenceZones():
   - Fetch H4 + H1 from MT5 bridge
   - Detect swing points → classify S/R/SBR/RBS zones
   - Merge nearby zones
   - Scan H1: CONFIRMED / PINBAR / ENGULFING
   - Build order params (entry, SL, TP, volume)
3. IF actionableSignals.length > 0:
   a. agent.js called with SCREENER goal + scan result
   b. prompt.js builds system prompt:
      - Scan result (zones, signals, orders)
      - Balance, positions, session
      - Lessons (seek/avoid patterns)
      - Recent decisions
   c. LLM reviews scan → approves one signal → calls open_order()
   d. Decision logged to trade-journal.json
4. IF no signals → silent skip (no LLM call, saves tokens)
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
| `scan_confluence_zones` | Screener | Labuu scanner: H4 zones + H1 signals |
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

---

## 🔬 Labuu Confluence Scanner

### Zone Types

| Zone | Origin | Condition | Signal |
|------|--------|-----------|--------|
| **S** (Support) | Swing Low | Never broken down | BUY |
| **R** (Resistance) | Swing High | Never broken up | SELL |
| **SBR** (S→R flip) | Swing Low | Broken down, price below level | SELL |
| **RBS** (R→S flip) | Swing High | Broken up, price above level | BUY |

### H1 Entry Signals

| Signal | Strength | Detection |
|--------|----------|-----------|
| **CONFIRMED** | 3 | Previous candle body already crossed the level |
| **PINBAR** | 2 | Shadow ≥ 2x body, body ≤ 40% candle range |
| **ENGULFING** | 2 | Current body fully engulfs previous body |

### Order Parameters

| Parameter | Value |
|-----------|-------|
| Order Type | BUY/SELL LIMIT |
| SL | 150 pips from entry |
| TP | 300 pips from entry (R:R 1:2) |
| Lot Size | 0.01 |
| Expiry | +4 hours (next H4 candle) |
| Max Spread | 100 pips |
| Filling | FOK (Fill or Kill) |

### Trailing Stop (Progressive)

| Profit | SL Moves To |
|--------|------------|
| ≥20 pips | Entry +5 (BE+5) |
| ≥30 pips | Entry +10 |
| ≥50 pips | Entry +15 |
| ≥100 pips | Entry +50 |
| ≥150 pips | Entry +100 |
| ≥200 pips | Entry +150 |
| ≥250 pips | Entry +200 |

SL only moves in profitable direction — never backwards.

### Token Efficiency

Scanner runs on CPU (free) every 60 seconds. LLM only called when actionable signals are found — estimated 10-30 calls/day vs 1,440/day full LLM approach.

---

*Generated 2026-06-03 by Exa 🦾*
