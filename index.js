/**
 * Forex LLM Agent — Main Entry Point
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

  const goal = `SCREENING CYCLE: Analyze XAU/USD for trade setups.

1. Fetch H1, M15, and M5 OHLCV data.
2. Check current spread.
3. Check account balance and open positions.
4. Analyze trend, support/resistance, and entry triggers.
5. If a high-conviction setup exists: open the trade with proper SL/TP.
6. If no setup: report why and skip.

Be decisive. Quality over quantity. Max ${config.screening?.maxPositions || 3} positions total.`;

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
║       FOREX LLM AGENT — XAU/USD          ║
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

  // Start REPL for manual interaction
  startREPL();
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("startup", "Received SIGINT — shutting down");
  stopCronJobs();
  shutdownBridge();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("startup", "Received SIGTERM — shutting down");
  stopCronJobs();
  shutdownBridge();
  process.exit(0);
});

main().catch(e => {
  log("error", `Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
