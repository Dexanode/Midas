#!/usr/bin/env node
/**
 * forex-llm CLI — direct commands with JSON output.
 * Inspired by Meridian's CLI architecture.
 */

import "dotenv/config";

const argv = process.argv.slice(2);
const subcommand = argv.find(a => !a.startsWith("-"));
const dryRun = argv.includes("--dry-run");

if (dryRun) process.env.DRY_RUN = "true";

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function die(msg, extra = {}) {
  process.stderr.write(JSON.stringify({ error: msg, ...extra }) + "\n");
  process.exit(1);
}

async function main() {
  switch (subcommand) {

    case "balance": {
      const { getBalance } = await import("./bridge/bridge.js");
      await import("./bridge/bridge.js").then(m => m.initBridge());
      const result = await getBalance();
      out(result);
      break;
    }

    case "positions": {
      const { initBridge, getPositions } = await import("./bridge/bridge.js");
      await initBridge();
      const result = await getPositions();
      out(result);
      break;
    }

    case "screen": {
      const { initBridge } = await import("./bridge/bridge.js");
      const { agentLoop } = await import("./agent.js");
      await initBridge().catch(() => {});

      const goal = `SCREENING: Analyze XAU/USD (H1, M15, M5) and report any high-conviction trade setups. Do NOT open trades — just analyze and report.`;
      const report = await agentLoop(goal, 12, [], "SCREENER");
      out({ done: true, report });
      break;
    }

    case "manage": {
      const { initBridge, getPositions } = await import("./bridge/bridge.js");
      const { agentLoop } = await import("./agent.js");
      await initBridge().catch(() => {});

      const posResult = await getPositions();
      if (!posResult?.ok || posResult.count === 0) {
        out({ done: true, report: "No open positions." });
        break;
      }

      const posDetails = posResult.positions.map((p, i) =>
        `#${i + 1} ${p.type} ${p.symbol} ${p.volume}lot @ ${p.open_price} → ${p.current_price} | PnL: ${p.pnl_pips} pips`
      ).join("\n");

      const goal = `MANAGEMENT: Review open positions and act:\n${posDetails}`;
      const report = await agentLoop(goal, 10, [], "MANAGER");
      out({ done: true, report });
      break;
    }

    case "ohlcv": {
      const { initBridge, getOHLCV } = await import("./bridge/bridge.js");
      await initBridge();
      const symbol = argv.find((_, i) => i > 0 && !argv[i].startsWith("-")) || "XAUUSD";
      const tf = argv.find(a => a.startsWith("--tf="))?.split("=")[1] || "M5";
      const bars = parseInt(argv.find(a => a.startsWith("--bars="))?.split("=")[1] || "100");
      const result = await getOHLCV(symbol, tf, bars);
      out(result);
      break;
    }

    case "performance": {
      const { getPerformanceSummary, getRecentDecisions } = await import("./decision-log.js");
      out({
        performance: getPerformanceSummary(),
        recentDecisions: getRecentDecisions(10),
      });
      break;
    }

    case "lessons": {
      const { getLessons, addManualLesson, togglePinLesson, clearLessons } = await import("./lessons.js");
      const sub = argv.find((a, i) => !a.startsWith("-") && i > 0 && argv[i - 1] === "lessons");
      if (sub === "add") {
        const text = argv.filter((a, i) => !a.startsWith("-") && i > 1).join(" ");
        if (!text) die("Usage: forex-llm lessons add <lesson text>");
        const lesson = addManualLesson(text);
        out(lesson ? { saved: true, rule: lesson.rule } : { saved: false, error: "Duplicate" });
      } else if (sub === "pin") {
        const id = argv.find((_, i) => i > 1 && !argv[i].startsWith("-"));
        if (!id) die("Usage: forex-llm lessons pin <lesson_id>");
        const pinned = togglePinLesson(id);
        out({ pinned, id });
      } else if (sub === "clear") {
        clearLessons();
        out({ cleared: true });
      } else {
        const limit = parseInt(argv.find((_, i) => i > 0 && !argv[i].startsWith("-") && argv[i] !== "lessons") || "50");
        out(getLessons(isNaN(limit) ? 50 : limit));
      }
      break;
    }

    case "evolve": {
      const { evolveThresholds } = await import("./lessons.js");
      const result = evolveThresholds();
      out(result);
      break;
    }

    case "config": {
      const { config } = await import("./config.js");
      const sub = argv.find((a, i) => !a.startsWith("-") && i > 0 && argv[i - 1] === "config");
      if (sub === "get") {
        out(config);
      } else if (sub === "set") {
        const key = argv.find((_, i) => i > 1 && !argv[i].startsWith("-"));
        const value = argv.find((_, i) => i > 2 && !argv[i].startsWith("-"));
        if (!key || !value) die("Usage: forex-llm config set <key> <value>");
        const { saveConfig } = await import("./config.js");
        let parsed;
        try { parsed = JSON.parse(value); } catch { parsed = value; }
        saveConfig({ [key]: parsed });
        out({ ok: true, key, value: parsed });
      }
      break;
    }

    case "start": {
      // Forward to index.js (autonomous mode)
      await import("./index.js");
      break;
    }

    default: {
      console.log(`forex-llm — Autonomous XAU/USD Trading Agent

Commands:
  forex-llm balance           Show account balance
  forex-llm positions          List open positions
  forex-llm screen             Run AI screening cycle (analysis only)
  forex-llm manage             Run AI management cycle
  forex-llm ohlcv [symbol] [--tf=M5] [--bars=100]  Fetch OHLCV data
  forex-llm performance        Show trade performance
  forex-llm config get         Show current config
  forex-llm config set <k> <v> Update config
  forex-llm lessons            List all lessons
  forex-llm lessons add <text> Add manual lesson
  forex-llm lessons pin <id>   Toggle pin a lesson
  forex-llm evolve             Evolve thresholds from performance
  forex-llm start              Start autonomous agent with cron

Flags:
  --dry-run    Skip all real orders (safe testing)
`);
      break;
    }
  }

  // Clean exit for MT5 bridge
  const { shutdownBridge } = await import("./bridge/bridge.js");
  shutdownBridge();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
