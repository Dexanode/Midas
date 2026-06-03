/**
 * Midas — Main Entry Point
 * Starts autonomous screening and management cycles on cron schedules.
 * Provides an interactive REPL for manual control.
 */
import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { initBridge, getBalance, getPositions, shutdownBridge } from "./bridge/bridge.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { setLastScreening, setLastManagement, isEmergencyStop } from "./state.js";
import { appendDecision, recordClosedTrade } from "./decision-log.js";
import { extractLessonFromTrade, evolveThresholds } from "./lessons.js";
import * as telegram from "./telegram.js";

const DRY_RUN = process.env.DRY_RUN === "true";

// ═══════════════════════════════════════════
//  CYCLE STATE
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

let _managementBusy = false;
let _screeningBusy = false;

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return 0;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  SCREENING CYCLE
// ═══════════════════════════════════════════
async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) return null;
  if (isEmergencyStop()) {
    log("cron", "Emergency stop active — skipping screening");
    return null;
  }

  _screeningBusy = true;
  timers.screeningLastRun = Date.now();
  log("cron", "🔍 Starting SCREENING cycle");

  const goal = `SCREENING CYCLE — Confluence Scanner Labuu Method

Step 1: Call scan_confluence_zones() to detect H4 zones + H1 signals
Step 2: Review the results — which zones have valid signals?
Step 3: Select the best signal (prioritize: CONFIRMED > PINBAR > ENGULFING)
Step 4: If you approve the signal → call open_order() using the EXACT params from scan result
Step 5: If no good signal → skip and report why

BE SELECTIVE. Max 1 entry per cycle. Max ${config.screening?.maxPositions || 3} total positions.`;

  try {
    const report = await agentLoop(goal, 15, [], "SCREENER");
    setLastScreening();

    // Log the decision
    appendDecision({
      type: "screening_cycle",
      summary: report?.slice(0, 200) || "Screening completed",
      reason: report,
    });

    log("cron", `Screening complete: ${report?.slice(0, 150)}...`);

    // Telegram notification
    if (telegram.isEnabled() && !silent && report) {
      telegram.notifyScreeningReport(report).catch(() => {});
    }

    return report;
  } catch (e) {
    log("error", `Screening failed: ${e.message}`);
    return null;
  } finally {
    _screeningBusy = false;
  }
}

// ═══════════════════════════════════════════
//  MANAGEMENT CYCLE
// ═══════════════════════════════════════════
async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  if (isEmergencyStop()) {
    log("cron", "Emergency stop active — skipping management");
    return null;
  }

  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "📊 Starting MANAGEMENT cycle");

  let positionsData;
  try {
    const result = await getPositions();
    positionsData = result;
  } catch (e) {
    log("error", `Failed to fetch positions: ${e.message}`);
    _managementBusy = false;
    return null;
  }

  if (!positionsData?.ok || positionsData.count === 0) {
    log("cron", "No open positions — triggering screening cycle");
    _managementBusy = false;
    runScreeningCycle().catch(e => log("error", `Triggered screening failed: ${e.message}`));
    return "No open positions. Triggering screening cycle.";
  }

  const positions = positionsData.positions;

  // Build detailed position data for the goal
  const posDetails = positions.map((p, i) =>
    `#${i + 1} Ticket:${p.ticket} | ${p.type} ${p.symbol} ${p.volume}lot
   Entry: ${p.open_price} | Current: ${p.current_price} | PnL: ${p.pnl_pips} pips ($${p.profit?.toFixed(2)})
   SL: ${p.sl || "NONE"} | TP: ${p.tp || "NONE"}
   Open: ${p.open_time || "unknown"}`
  ).join("\n\n");

  const goal = `MANAGEMENT CYCLE: Manage ${positions.length} open XAU/USD position(s).

OPEN POSITIONS:
${posDetails}

TASKS:
1. For EACH position, check if SL is set. If not → set one.
2. Check if any position qualifies for breakeven move (profit > breakeven threshold).
3. Check if any position has hit partial-profit target → take partial profits.
4. Check if any position should be closed (deep loss, sideways too long).
5. If all positions are healthy, report summary and hold.

BE DECISIVE. Call modify_position or close_position as needed.`;

  try {
    const report = await agentLoop(goal, 12, [], "MANAGER");
    setLastManagement();
    log("cron", `Management complete: ${report?.slice(0, 150)}...`);

    // Telegram notification
    if (telegram.isEnabled() && !silent && report) {
      telegram.notifyManagementReport(report).catch(() => {});
    }

    return report;
  } catch (e) {
    log("error", `Management failed: ${e.message}`);
    return null;
  } finally {
    _managementBusy = false;
  }
}

// ═══════════════════════════════════════════
//  CRON SCHEDULER
// ═══════════════════════════════════════════
let _cronJobs = [];

function startCronJobs() {
  const screeningMin = config.schedule.screeningIntervalMin;
  const managementMin = config.schedule.managementIntervalMin;

  // Screening: every N minutes
  const screenJob = cron.schedule(`*/${screeningMin} * * * *`, () => {
    runScreeningCycle().catch(e => log("error", `Cron screening: ${e.message}`));
  });
  _cronJobs.push(screenJob);
  log("startup", `Screening cron: every ${screeningMin} min`);

  // Management: every N minutes
  const mgmtJob = cron.schedule(`*/${managementMin} * * * *`, () => {
    runManagementCycle().catch(e => log("error", `Cron management: ${e.message}`));
  });
  _cronJobs.push(mgmtJob);
  log("startup", `Management cron: every ${managementMin} min`);
}

function stopCronJobs() {
  for (const job of _cronJobs) job.stop();
  _cronJobs = [];
}

// ═══════════════════════════════════════════
//  REPL
// ═══════════════════════════════════════════
function startREPL() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.setPrompt(buildPrompt());
      rl.prompt();
      return;
    }

    switch (input.toLowerCase()) {
      case "/status": {
        const bal = await getBalance().catch(() => null);
        const pos = await getPositions().catch(() => null);
        console.log(bal?.ok ? `Balance: $${bal.balance} | Equity: $${bal.equity} | Free Margin: $${bal.free_margin}` : "Balance: unavailable");
        if (pos?.ok) {
          console.log(`Open Positions: ${pos.count}`);
          pos.positions?.forEach(p => {
            console.log(`  #${p.ticket} ${p.type} ${p.symbol} ${p.volume}lot @ ${p.open_price} → ${p.current_price} | PnL: ${p.pnl_pips} pips`);
          });
        }
        break;
      }
      case "/screen":
        await runScreeningCycle();
        break;
      case "/manage":
        await runManagementCycle();
        break;
      case "/lessons": {
        const { getLessons } = await import("./lessons.js");
        const ls = getLessons(20);
        console.log(`\n📚 Lessons (${ls.total} total):`);
        ls.lessons.forEach((l, i) => {
          const icon = l.outcome === "win" ? "🟢" : l.outcome === "loss" ? "🔴" : "📝";
          console.log(`${i + 1}. ${icon}${l.pinned ? " 📌" : ""} ${l.rule}`);
          console.log(`   ${l.outcome} | ${l.context || "unknown context"} | used ${l.usage_count}x`);
        });
        break;
      }
      case "/evolve": {
        const result = evolveThresholds();
        if (result.evolved) {
          console.log(`\n🧬 Thresholds evolved!`);
          console.log(`Changes: ${JSON.stringify(result.changes)}`);
          console.log(`Rationale: ${result.rationale}`);
        } else {
          console.log(`\nNo evolution — ${result.rationale}`);
        }
        break;
      }
      case "/stop":
        console.log("Shutting down...");
        stopCronJobs();
        shutdownBridge();
        rl.close();
        process.exit(0);
      default: {
        // Free-form chat / command
        const report = await agentLoop(input, 10, [], "GENERAL");
        console.log(report);
      }
    }

    rl.setPrompt(buildPrompt());
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });
}

// ═══════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════
async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║           🪙  M I D A S  🪙               ║
║       XAU/USD Autonomous Agent            ║
║       Meridian-inspired, MT5-powered      ║
╠══════════════════════════════════════════╣
║  Mode: ${DRY_RUN ? "🔴 DRY RUN" : "🟢 LIVE"}                          ║
║  Symbol: XAUUSD                           ║
║  Screening: every ${String(config.schedule.screeningIntervalMin).padEnd(3)}min                    ║
║  Management: every ${String(config.schedule.managementIntervalMin).padEnd(3)}min                   ║
╚══════════════════════════════════════════╝
`);

  // Init MT5 bridge
  const bridgeOk = await initBridge();
  if (!bridgeOk && !DRY_RUN) {
    log("error", "Cannot start — MT5 bridge failed. Make sure MT5 terminal is running and logged into Valetax.");
    log("error", "Run with DRY_RUN=true for testing without live MT5.");
    process.exit(1);
  }

  if (DRY_RUN) {
    log("startup", "DRY RUN mode — no real orders will be placed. MT5 bridge is optional.");
  }

  // Start cron jobs
  startCronJobs();

  // Run first cycle immediately
  log("startup", "Running initial cycles...");
  await runScreeningCycle().catch(e => log("error", `Initial screening: ${e.message}`));
  await runManagementCycle().catch(e => log("error", `Initial management: ${e.message}`));

  // Start Telegram if configured
  if (telegram.isEnabled()) {
    log("startup", "Starting Telegram integration...");
    registerTelegramHandlers();
    telegram.startPolling();
  }

  // Start REPL for manual interaction
  startREPL();
}

// ═══════════════════════════════════════════
//  TELEGRAM HANDLERS
// ═══════════════════════════════════════════
function registerTelegramHandlers() {
  telegram.onCommand("status", async (args, msg) => {
    const bal = await getBalance().catch(() => null);
    const pos = await getPositions().catch(() => null);
    let text = "🪙 <b>MIDAS — Status</b>\n────────────────────\n";
    if (bal?.ok) {
      text += `Balance: <b>$${bal.balance}</b>\nEquity: $${bal.equity}\nFree Margin: $${bal.free_margin}\nFloating PnL: $${bal.profit}\n\n`;
    }
    if (pos?.ok) {
      text += `<b>Open Positions: ${pos.count}</b>\n`;
      pos.positions?.forEach((p, i) => {
        text += `${i + 1}. ${p.type} ${p.symbol} ${p.volume}lot @ ${p.open_price} → ${p.current_price}\n   PnL: ${p.pnl_pips} pips | $${p.profit?.toFixed(2)}\n`;
      });
    }
    if (!pos?.ok || pos.count === 0) text += "No open positions.";
    await telegram.sendHTML(text);
  });

  telegram.onCommand("positions", async () => {
    const pos = await getPositions().catch(() => null);
    if (!pos?.ok || pos.count === 0) {
      await telegram.sendHTML("📊 No open positions.");
      return;
    }
    let text = `<b>📊 Open Positions (${pos.count})</b>\n────────────────────\n`;
    pos.positions?.forEach((p, i) => {
      const emoji = p.pnl_pips > 0 ? "🟢" : "🔴";
      text += `${emoji} <b>#${i + 1}</b> Ticket: <code>${p.ticket}</code>\n`;
      text += `${p.type} ${p.symbol} ${p.volume}lot\n`;
      text += `${p.open_price} → ${p.current_price} | ${p.pnl_pips > 0 ? "+" : ""}${p.pnl_pips} pips\n`;
      text += `SL: ${p.sl || "—"} | TP: ${p.tp || "—"}\n\n`;
    });
    await telegram.sendHTML(text);
  });

  telegram.onCommand("close", async (args) => {
    const index = parseInt(args) - 1;
    const pos = await getPositions().catch(() => null);
    if (!pos?.ok || !pos.positions?.[index]) {
      await telegram.sendHTML("❌ Invalid position number. Use /positions first.");
      return;
    }
    const target = pos.positions[index];
    try {
      const { closePosition } = await import("./bridge/bridge.js");
      const result = await closePosition(target.ticket);
      if (result.ok) {
        await telegram.sendHTML(`✅ Closed ${target.type} ${target.symbol} ticket ${target.ticket}\nPnL: ${target.pnl_pips} pips / $${target.profit?.toFixed(2)}`);
      } else {
        await telegram.sendHTML(`❌ Close failed: ${result.error}`);
      }
    } catch (e) {
      await telegram.sendHTML(`❌ Error: ${e.message}`);
    }
  });

  telegram.onCommand("screen", async () => {
    await telegram.sendHTML("🔍 Running screening cycle...");
    const report = await runScreeningCycle();
    if (report) {
      await telegram.notifyScreeningReport(report);
    }
  });

  telegram.onCommand("manage", async () => {
    await telegram.sendHTML("📊 Running management cycle...");
    const report = await runManagementCycle();
    if (report) {
      await telegram.notifyManagementReport(report);
    }
  });

  telegram.onCommand("lessons", async () => {
    const { getLessons } = await import("./lessons.js");
    const ls = getLessons(10);
    if (ls.total === 0) {
      await telegram.sendHTML("📚 No lessons yet — keep trading!");
      return;
    }
    let text = `<b>📚 Lessons (${ls.total} total)</b>\n────────────────────\n`;
    ls.lessons.forEach((l, i) => {
      const icon = l.outcome === "win" ? "🟢" : l.outcome === "loss" ? "🔴" : "📝";
      text += `${icon} ${l.pinned ? "📌" : ""} ${l.rule}\n`;
      text += `<i>${l.outcome} • ${l.context || ""} • used ${l.usage_count}x</i>\n\n`;
    });
    await telegram.sendHTML(text);
  });

  telegram.onCommand("evolve", async () => {
    const result = evolveThresholds();
    if (result.evolved) {
      await telegram.sendHTML(`🧬 <b>Thresholds Evolved!</b>\n────────────────────\n${JSON.stringify(result.changes, null, 2)}\n\n<i>${result.rationale}</i>`);
    } else {
      await telegram.sendHTML(`🧬 No evolution needed.\n<i>${result.rationale}</i>`);
    }
  });

  telegram.onCommand("help", async () => {
    await telegram.sendHTML(`🪙 <b>MIDAS — Commands</b>
────────────────────
/status — Balance + positions
/positions — Open positions detail
/close &lt;n&gt; — Close position by number
/screen — Run screening cycle
/manage — Run management cycle
/lessons — View learned lessons
/evolve — Auto-evolve thresholds
/help — This message

<i>Or just chat naturally — Midas understands.</i>`);
  });

  // Free-form chat → goes to agent
  telegram.onChatMessage(async (text) => {
    await telegram.sendHTML("🤔 Thinking...");
    const report = await agentLoop(text, 10, [], "GENERAL");
    await telegram.sendHTML(report || "I'm not sure about that.");
  });

  log("startup", "Telegram handlers registered");
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("startup", "Received SIGINT — shutting down");
  telegram.stopPolling();
  stopCronJobs();
  shutdownBridge();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("startup", "Received SIGTERM — shutting down");
  telegram.stopPolling();
  stopCronJobs();
  shutdownBridge();
  process.exit(0);
});

main().catch(e => {
  log("error", `Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
