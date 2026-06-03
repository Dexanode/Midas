import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "user-config.json");

let _config = null;

function load() {
  if (_config) return _config;
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn("user-config.json not found, using defaults");
    _config = getDefaults();
    return _config;
  }
  try {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // Merge with defaults for any missing keys
    _config = { ...getDefaults(), ..._config };
    return _config;
  } catch (e) {
    console.error(`Invalid user-config.json: ${e.message}`);
    _config = getDefaults();
    return _config;
  }
}

function getDefaults() {
  return {
    symbol: "XAUUSD",
    timeframe: "M5",
    screening: {
      intervalMin: 1,  // 60 seconds (Labuu scanner)
      maxPositions: 3,
      riskPerTradePct: 1.0,
      minRiskRewardRatio: 1.5,
      maxSpreadPips: 35,
      minATR: 200,
      allowedSessions: ["London", "New York"],
      avoidNewsMinutes: 30,
    },
    management: {
      intervalMin: 5,
      trailingStopPips: 0,
      takeProfitPips: 0,
      stopLossPips: 0,
      breakevenAfterPips: 100,
      breakevenLockPips: 10,
      partialClosePct: 50,
      partialCloseAfterPips: 80,
      maxDrawdownPct: -5,
      outOfRangeWaitMinutes: 60,
    },
    schedule: {
      screeningIntervalMin: 1,  // 60 seconds for Labuu scanner
      managementIntervalMin: 5,
    },
    llm: {
      maxSteps: 15,
      screeningModel: "openai/gpt-oss-20b:free",
      managementModel: "openai/gpt-oss-20b:free",
      generalModel: "openai/gpt-oss-20b:free",
    },
    risk: {
      maxDailyLossPct: 3.0,
      maxWeeklyLossPct: 6.0,
      maxConsecutiveLosses: 5,
    },
  };
}

export function saveConfig(updates) {
  const current = load();
  const merged = deepMerge(current, updates);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  _config = merged;
  return merged;
}

export function getConfig(key) {
  const c = load();
  if (!key) return c;
  return key.split(".").reduce((o, k) => o?.[k], c);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export const config = new Proxy({}, {
  get(_, prop) {
    return load()[prop];
  }
});
