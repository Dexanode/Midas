/**
 * Lightweight in-memory state tracker for open positions.
 * Persisted to state.json between restarts.
 */
import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

let _state = {
  positions: {},      // positionId → { ticket, entryPrice, direction, sl, tp, pnl, instruction }
  dailyPnL: 0,
  weeklyPnL: 0,
  consecutiveLosses: 0,
  lastScreening: null,
  lastManagement: null,
  emergencyStop: false,
};

function load() {
  if (!fs.existsSync(STATE_FILE)) return;
  try { _state = { ..._state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; }
  catch (e) { log("warn", `Bad state.json: ${e.message}`); }
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
}

load();

// ─── Position tracking ─────────────────────────────────────────

export function trackPosition(positionId, data) {
  _state.positions[positionId] = {
    ..._state.positions[positionId],
    ...data,
    openedAt: _state.positions[positionId]?.openedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  save();
}

export function untrackPosition(positionId) {
  delete _state.positions[positionId];
  save();
}

export function getTrackedPositions() {
  return { ..._state.positions };
}

export function getTrackedPosition(positionId) {
  return _state.positions[positionId] || null;
}

export function isPositionTracked(positionId) {
  return positionId in _state.positions;
}

export function setPositionInstruction(positionId, instruction) {
  if (_state.positions[positionId]) {
    _state.positions[positionId].instruction = instruction;
    _state.positions[positionId].updatedAt = new Date().toISOString();
    save();
  }
}

// ─── Risk state ─────────────────────────────────────────────────

export function updateDailyPnL(pnl) {
  _state.dailyPnL += pnl;
  save();
}

export function getDailyPnL() {
  return _state.dailyPnL;
}

export function updateConsecutiveLosses(isLoss) {
  _state.consecutiveLosses = isLoss ? _state.consecutiveLosses + 1 : 0;
  save();
}

export function getConsecutiveLosses() {
  return _state.consecutiveLosses;
}

export function isEmergencyStop() {
  return _state.emergencyStop;
}

export function setEmergencyStop(reason) {
  _state.emergencyStop = true;
  log("error", `EMERGENCY STOP: ${reason}`);
  save();
}

export function clearEmergencyStop() {
  _state.emergencyStop = false;
  save();
}

// ─── Cycle state ────────────────────────────────────────────────

export function setLastScreening() {
  _state.lastScreening = new Date().toISOString();
  save();
}

export function setLastManagement() {
  _state.lastManagement = new Date().toISOString();
  save();
}

export function getStateSummary() {
  return {
    openPositions: Object.keys(_state.positions).length,
    dailyPnL: _state.dailyPnL.toFixed(2),
    consecutiveLosses: _state.consecutiveLosses,
    emergencyStop: _state.emergencyStop,
    lastScreening: _state.lastScreening,
    lastManagement: _state.lastManagement,
  };
}
