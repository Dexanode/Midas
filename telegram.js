/**
 * Telegram integration for Midas.
 * Handles bot polling, commands, and auto-notifications.
 * Inspired by Meridian's telegram.js.
 *
 * Setup:
 *  1. Create bot via @BotFather → get token
 *  2. Add TELEGRAM_BOT_TOKEN=*** to .env
 *  3. Send any message to bot — auto-registers chat ID
 *  4. For forum groups: add TELEGRAM_TOPIC_ID=*** to .env
 */
import { log } from "./logger.js";
import { config } from "./config.js";
import { getDecisionSummary } from "./decision-log.js";

// ─── Config ─────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TOPIC_ID = process.env.TELEGRAM_TOPIC_ID || null;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let _chatId = process.env.TELEGRAM_CHAT_ID || null;
let _polling = false;
let _pollAbort = null;
let _commandHandlers = {};
let _chatHandler = null;

// Offsets for pagination tracking
let _lastUpdateId = 0;

// ─── State ──────────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

export function getChatId() {
  return _chatId;
}

// ─── Low-level API ──────────────────────────────────────────────

async function api(method, body = {}) {
  if (!API) return null;

  // Auto-attach topic for forum groups
  if (TOPIC_ID && body.chat_id === _chatId && !body.message_thread_id && method !== "getUpdates") {
    body.message_thread_id = TOPIC_ID;
  }

  try {
    const url = `${API}/${method}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.ok) {
      log("telegram_warn", `Telegram API error [${method}]: ${data.description}`);
    }
    return data;
  } catch (e) {
    log("telegram_warn", `Telegram API failed [${method}]: ${e.message}`);
    return null;
  }
}

// ─── Message sending ────────────────────────────────────────────

export async function sendMessage(text, options = {}) {
  if (!_chatId || !API) return null;
  // Telegram limit is 4096 chars
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n\n... (truncated)" : text;
  return api("sendMessage", {
    chat_id: _chatId,
    text: truncated,
    parse_mode: options.parse_mode || "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

export async function sendHTML(html) {
  return sendMessage(html, { parse_mode: "HTML" });
}

/**
 * Edit an existing message. Returns null on failure (message may be too old).
 */
export async function editMessage(messageId, text) {
  if (!_chatId || !API) return null;
  return api("editMessageText", {
    chat_id: _chatId,
    message_id: messageId,
    text: text.length > 4000 ? text.slice(0, 4000) + "..." : text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

/**
 * Pin a message in the chat.
 */
export async function pinMessage(messageId) {
  if (!_chatId || !API) return null;
  return api("pinChatMessage", {
    chat_id: _chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

/**
 * Send a live message placeholder, return its message_id for later edits.
 */
export async function createLiveMessage(title, body) {
  const text = `${title}\n<pre>${body}</pre>`;
  const result = await sendHTML(text);
  return result?.result?.message_id || null;
}

// ─── Notification Helpers ───────────────────────────────────────

export async function notifyEntry(orderData) {
  const { symbol, type, volume, price, sl, tp, ticket } = orderData;
  const slDisplay = sl ? `$${sl}` : "NONE";
  const tpDisplay = tp ? `$${tp}` : "NONE";

  const text = `🎯 <b>MIDAS — Entry</b>
────────────────────
<b>${symbol}</b> • ${type} ${volume}lot
Entry: <b>$${price}</b>
SL: ${slDisplay}  |  TP: ${tpDisplay}
Ticket: <code>#${ticket}</code>

<i>${orderData.comment || "Autonomous entry"}</i>`;

  const result = await sendHTML(text);
  if (result?.result?.message_id) {
    // Pin entry, unpin the old one
    await pinMessage(result.result.message_id);
  }
}

export async function notifyExit(exitData) {
  const { symbol, type, entryPrice, exitPrice, pips, profit, ticket, reason } = exitData;
  const emoji = pips > 0 ? "🟢" : "🔴";

  const text = `${emoji} <b>MIDAS — Exit</b>
────────────────────
<b>${symbol}</b> • ${type} → <b>CLOSED</b>
${entryPrice} → ${exitPrice} (${pips > 0 ? "+" : ""}${pips} pips)
PnL: <b>$${profit?.toFixed(2) || "N/A"}</b>
Ticket: <code>#${ticket}</code>

${reason ? `<i>Reason: ${reason}</i>` : ""}`;

  return sendHTML(text);
}

export async function notifyManagementReport(report) {
  const summary = report.length > 3000 ? report.slice(0, 3000) + "\n\n<i>...truncated</i>" : report;
  const text = `📊 <b>MIDAS — Management Report</b>
────────────────────
${summary}`;

  return sendHTML(text);
}

export async function notifyScreeningReport(report) {
  const summary = report.length > 3000 ? report.slice(0, 3000) + "\n\n<i>...truncated</i>" : report;
  const text = `🔍 <b>MIDAS — Screening Report</b>
────────────────────
${summary}`;

  return sendHTML(text);
}

export async function notifyEmergency(reason) {
  const text = `🛑 <b>MIDAS — EMERGENCY STOP</b>
────────────────────
${reason}

<b>All trading halted.</b> Manual intervention required.
Use <code>/resume</code> to re-enable after review.`;

  return sendHTML(text);
}

export async function notifyMorningBriefing(briefing) {
  const text = `🌅 <b>MIDAS — Daily Briefing</b>
────────────────────
${briefing}`;

  return sendHTML(text);
}

// ─── Command Handling ───────────────────────────────────────────

export function onCommand(command, handler) {
  _commandHandlers[command] = handler;
}

export function onChatMessage(handler) {
  _chatHandler = handler;
}

function extractCommand(text) {
  if (!text) return null;
  // Handle /command or /command@botname
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+(.*))?/s);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2]?.trim() || "" };
}

// ─── Long Polling ───────────────────────────────────────────────

async function poll() {
  if (!API) return;

  try {
    const params = {
      offset: _lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ["message"],
    };

    const url = `${API}/getUpdates?${new URLSearchParams(params).toString()}`;
    const resp = await fetch(url, { signal: _pollAbort?.signal });
    const data = await resp.json();

    if (!data.ok) {
      log("telegram_warn", `Poll error: ${data.description}`);
      return;
    }

    for (const update of data.result) {
      _lastUpdateId = Math.max(_lastUpdateId, update.update_id);

      const msg = update.message || update.edited_message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      // Auto-register chat ID on first message
      if (!_chatId) {
        _chatId = chatId;
        log("startup", `Telegram chat registered: ${chatId}`);
        await sendHTML(`🪙 <b>MIDAS — Connected</b>\n\nBot online. Use /help to see available commands.`);
      }

      // Only respond to registered chat
      if (chatId !== _chatId) continue;

      const cmd = extractCommand(text);

      if (cmd && _commandHandlers[cmd.command]) {
        try {
          await _commandHandlers[cmd.command](cmd.args, msg);
        } catch (e) {
          log("telegram_warn", `Command /${cmd.command} failed: ${e.message}`);
        }
      } else if (_chatHandler && !text.startsWith("/")) {
        try {
          await _chatHandler(text, msg);
        } catch (e) {
          log("telegram_warn", `Chat handler failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    log("telegram_warn", `Poll loop error: ${e.message}`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

export async function startPolling() {
  if (!isEnabled()) {
    log("startup", "Telegram: disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }
  if (_polling) return;

  _polling = true;
  _pollAbort = new AbortController();
  log("startup", "Telegram polling started");

  // Auto-save chat ID to .env when it changes
  if (_chatId) {
    log("startup", `Telegram chat ID: ${_chatId}`);
  }

  // Continuous poll loop
  (async () => {
    while (_polling) {
      await poll();
    }
  })();
}

export function stopPolling() {
  _polling = false;
  if (_pollAbort) {
    _pollAbort.abort();
    _pollAbort = null;
  }
  log("startup", "Telegram polling stopped");
}
