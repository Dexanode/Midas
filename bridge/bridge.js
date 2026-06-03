/**
 * Node.js client for the MT5 Python bridge.
 * Spawns a Python subprocess and communicates via JSON-line stdin/stdout.
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, "mt5_bridge.py");

let _proc = null;
let _pending = new Map();
let _reqId = 0;
let _initialized = false;

function getProc() {
  if (_proc) return _proc;

  _proc = spawn("python3", [BRIDGE_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  _proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const resp = JSON.parse(line);
        const resolver = _pending.get(resp.id);
        if (resolver) {
          _pending.delete(resp.id);
          resolver(resp);
        }
      } catch (e) {
        // ignore parse errors
      }
    }
  });

  _proc.stderr.on("data", (chunk) => {
    log("error", `MT5 Bridge stderr: ${chunk.toString().trim()}`);
  });

  _proc.on("close", (code) => {
    log("warn", `MT5 Bridge exited (code ${code})`);
    _proc = null;
    _initialized = false;
    // Reject all pending
    for (const [id, resolver] of _pending) {
      resolver({ ok: false, error: "Bridge disconnected", id });
    }
    _pending.clear();
  });

  return _proc;
}

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++_reqId;
    const proc = getProc();

    const timeout = setTimeout(() => {
      _pending.delete(id);
      resolve({ ok: false, error: `Bridge timeout: ${method}`, id });
    }, 15000);

    _pending.set(id, (resp) => {
      clearTimeout(timeout);
      resolve(resp);
    });

    proc.stdin.write(JSON.stringify({ method, params, id }) + "\n");
  });
}

export async function initBridge() {
  if (_initialized) return true;
  const result = await send("init");
  if (result.ok) {
    _initialized = true;
    log("startup", `MT5 Bridge connected — ${result.account?.login} @ ${result.account?.server} | Balance: $${result.account?.balance}`);
  } else {
    log("error", `MT5 Bridge init failed: ${result.error}`);
  }
  return result.ok;
}

export async function getOHLCV(symbol, timeframe, bars = 100) {
  return send("get_ohlcv", { symbol, timeframe, bars });
}

export async function getBalance() {
  return send("get_balance");
}

export async function getPositions() {
  return send("get_positions");
}

export async function openOrder(params) {
  return send("open_order", params);
}

export async function closePosition(ticket, deviation = 20) {
  return send("close_position", { ticket, deviation });
}

export async function modifyPosition(ticket, sl, tp) {
  return send("modify_position", { ticket, sl, tp });
}

export async function getSpread(symbol = "XAUUSD") {
  return send("get_spread", { symbol });
}

export async function getNews() {
  return send("get_news");
}

export function shutdownBridge() {
  if (_proc) {
    _proc.stdin.write(JSON.stringify({ method: "shutdown" }) + "\n");
    setTimeout(() => { if (_proc) _proc.kill(); }, 3000);
  }
}
