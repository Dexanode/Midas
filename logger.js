const LOG_LEVELS = { startup: 0, cron: 1, agent: 2, trade: 1, state: 2, error: 0, warn: 1 };

export function log(level, message) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const icon = {
    startup: "🚀", cron: "⏰", agent: "🧠", trade: "💹",
    state: "📊", error: "❌", warn: "⚠️",
  }[level] || "ℹ️";
  console.log(`[${ts}] ${icon} [${level}] ${message}`);
}
