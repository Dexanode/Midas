/**
 * Confluence Scanner — Labuu Method
 * ==================================
 * H4 Zone Scanning: S / R / SBR / RBS
 * H1 Entry Confirmation: Pinbar / Engulfing / Confirmed
 *
 * Pure Node.js implementation — no Python dependency.
 * Gets OHLCV data from MT5 bridge.
 *
 * Based on: https://github.com/Dexanode/confluence
 */
import { getOHLCV, getSpread } from "../bridge/bridge.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════
//  CONFIG (overridable from user-config.json)
// ═══════════════════════════════════════════
let CONFIG = {
  symbol: "XAUUSD",
  // Scanning
  h4Lookback: 100,
  h1Lookback: 200,
  confluenceTolerancePips: 30,
  touchTolerancePips: 30,
  breakThresholdPips: 10,
  reclaimThresholdPips: 50,
  zoneMergePips: 50,
  maxZones: 10,
  minBodyPips: 5,
  // Swing detection
  swingLeft: 2,
  swingRight: 2,
  // H1 signal
  pinbarMinShadowRatio: 2.0,
  pinbarMaxBodyPct: 0.4,
  // Risk
  slPips: 150,
  tpPips: 300,
  lotSize: 0.01,
  maxSpreadPips: 100,
  // Trailing
  trailingStopSteps: [
    [20, 5],
    [30, 10],
    [50, 15],
    [100, 50],
    [150, 100],
    [200, 150],
    [250, 200],
  ],
};

/** Reconfigure scanner at runtime */
export function configureScanner(overrides) {
  CONFIG = { ...CONFIG, ...overrides };
  // Merge nested objects shallowly
  if (overrides.trailingStopSteps) CONFIG.trailingStopSteps = overrides.trailingStopSteps;
}

// ═══════════════════════════════════════════
//  PIP UTILS
// ═══════════════════════════════════════════
const PIP_SIZE = 0.10;
function pips(value) { return value * PIP_SIZE; }
function toPips(priceDiff) { return Math.abs(priceDiff) / PIP_SIZE; }

// ═══════════════════════════════════════════
//  CANDLE HELPERS
// ═══════════════════════════════════════════
function bodyOpen(c) { return c.open; }
function bodyClose(c) { return c.close; }
function bodyTop(c) { return Math.max(c.open, c.close); }
function bodyBottom(c) { return Math.min(c.open, c.close); }
function bodySize(c) { return Math.abs(c.close - c.open); }
function isBullish(c) { return c.close > c.open; }
function isBearish(c) { return c.close < c.open; }
function candleRange(c) { return c.high - c.low; }
function upperShadow(c) { return c.high - bodyTop(c); }
function lowerShadow(c) { return bodyBottom(c) - c.low; }

// ═══════════════════════════════════════════
//  SWING DETECTION (body-based)
// ═══════════════════════════════════════════
function findSwingHighs(candles, left = 2, right = 2) {
  const swings = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high;
    let ok = true;
    for (let j = 1; j <= left; j++) if (candles[i - j].high >= h) ok = false;
    for (let j = 1; j <= right; j++) if (candles[i + j].high >= h) ok = false;
    if (ok) {
      swings.push({ index: i, level: bodyTop(candles[i]), time: candles[i].time });
    }
  }
  return swings; // sorted by index ascending
}

function findSwingLows(candles, left = 2, right = 2) {
  const swings = [];
  for (let i = left; i < candles.length - right; i++) {
    const l = candles[i].low;
    let ok = true;
    for (let j = 1; j <= left; j++) if (candles[i - j].low <= l) ok = false;
    for (let j = 1; j <= right; j++) if (candles[i + j].low <= l) ok = false;
    if (ok) {
      swings.push({ index: i, level: bodyBottom(candles[i]), time: candles[i].time });
    }
  }
  return swings;
}

// ═══════════════════════════════════════════
//  BREAK DETECTION
// ═══════════════════════════════════════════
function isLevelBrokenDown(level, candles, fromIndex) {
  const threshold = pips(CONFIG.breakThresholdPips);
  for (let i = fromIndex + 1; i < candles.length; i++) {
    if (bodyBottom(candles[i]) < level - threshold) return true;
  }
  return false;
}

function isLevelBrokenUp(level, candles, fromIndex) {
  const threshold = pips(CONFIG.breakThresholdPips);
  for (let i = fromIndex + 1; i < candles.length; i++) {
    if (bodyTop(candles[i]) > level + threshold) return true;
  }
  return false;
}

/**
 * SBR validity: was broken down, no reclaim back up past the level.
 */
function isSBRStillValid(level, candles, swingIdx) {
  const brk = pips(CONFIG.breakThresholdPips);
  let hasBroken = false;
  for (let i = swingIdx + 1; i < candles.length; i++) {
    if (bodyBottom(candles[i]) < level - brk) hasBroken = true;
    if (hasBroken && bodyTop(candles[i]) > level + brk) return false; // reclaimed
  }
  return hasBroken;
}

/**
 * RBS validity: was broken up, no reclaim back down past the level.
 */
function isRBSStillValid(level, candles, swingIdx) {
  const brk = pips(CONFIG.breakThresholdPips);
  let hasBroken = false;
  for (let i = swingIdx + 1; i < candles.length; i++) {
    if (bodyTop(candles[i]) > level + brk) hasBroken = true;
    if (hasBroken && bodyBottom(candles[i]) < level - brk) return false; // reclaimed
  }
  return hasBroken;
}

// ═══════════════════════════════════════════
//  ZONE CLASSIFICATION
// ═══════════════════════════════════════════
function classifyZones(swingHighs, swingLows, h4Candles, currentPrice) {
  const zones = []; // { level, type, priority, sourceIndex, sourceTime }

  // Helper: is zone within reasonable distance?
  const isInRange = (level) => Math.abs(currentPrice - level) <= pips(1000); // 1000 pips from price

  // R = Resistance (swing high, never broken up)
  for (const sh of swingHighs) {
    if (!isLevelBrokenUp(sh.level, h4Candles, sh.index) && isInRange(sh.level)) {
      zones.push({ level: sh.level, type: "R", direction: "SELL", sourceIndex: sh.index, sourceTime: sh.time, strength: 1 });
    }
  }

  // S = Support (swing low, never broken down)
  for (const sl of swingLows) {
    if (!isLevelBrokenDown(sl.level, h4Candles, sl.index) && isInRange(sl.level)) {
      zones.push({ level: sl.level, type: "S", direction: "BUY", sourceIndex: sl.index, sourceTime: sl.time, strength: 1 });
    }
  }

  // SBR = Support→Resistance (swing low, now broken down & price below)
  for (const sl of swingLows) {
    if (isSBRStillValid(sl.level, h4Candles, sl.index) && currentPrice < sl.level && isInRange(sl.level)) {
      zones.push({ level: sl.level, type: "SBR", direction: "SELL", sourceIndex: sl.index, sourceTime: sl.time, strength: 2 });
    }
  }

  // RBS = Resistance→Support (swing high, now broken up & price above)
  for (const sh of swingHighs) {
    if (isRBSStillValid(sh.level, h4Candles, sh.index) && currentPrice > sh.level && isInRange(sh.level)) {
      zones.push({ level: sh.level, type: "RBS", direction: "BUY", sourceIndex: sh.index, sourceTime: sh.time, strength: 2 });
    }
  }

  return zones;
}

// ═══════════════════════════════════════════
//  ZONE MERGING
// ═══════════════════════════════════════════
function mergeZones(zones) {
  if (zones.length <= 1) return zones;

  // Sort by level ascending
  const sorted = [...zones].sort((a, b) => a.level - b.level);
  const merged = [];
  let currentGroup = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = currentGroup[currentGroup.length - 1];
    if (toPips(Math.abs(sorted[i].level - last.level)) <= CONFIG.zoneMergePips) {
      currentGroup.push(sorted[i]);
    } else {
      merged.push(groupMerge(currentGroup));
      currentGroup = [sorted[i]];
    }
  }
  merged.push(groupMerge(currentGroup));
  return merged;
}

function groupMerge(group) {
  const avgLevel = group.reduce((s, z) => s + z.level, 0) / group.length;
  // Pick the "strongest" type: prioritize flip zones (SBR/RBS) over pure zones
  const best = group.reduce((a, b) => a.strength >= b.strength ? a : b);
  return {
    level: +avgLevel.toFixed(2),
    type: best.type,
    direction: best.direction,
    strength: best.strength,
    // Keep all source types for reference
    sources: group.map(z => z.type),
  };
}

// ═══════════════════════════════════════════
//  H1 ENTRY SIGNALS
// ═══════════════════════════════════════════
function detectH1Signals(zone, h1Candles, currentPrice) {
  const touchTol = pips(CONFIG.touchTolerancePips);
  const zoneLevel = zone.level;
  const direction = zone.direction;

  // Check proximity: is price within touch tolerance of the zone?
  if (Math.abs(currentPrice - zoneLevel) > touchTol) {
    return { zone, signals: [], reason: `Price too far from zone (${toPips(Math.abs(currentPrice - zoneLevel)).toFixed(0)} pips away)` };
  }

  const latest = h1Candles[h1Candles.length - 1];
  const prev = h1Candles[h1Candles.length - 2];
  if (!latest || !prev) return { zone, signals: [] };

  const signals = [];

  if (direction === "BUY") {
    // BUY signals: Support / RBS zone
    // Prerequisite: H1 close above zone level
    if (latest.close < zoneLevel - pips(CONFIG.touchTolerancePips)) {
      return { zone, signals: [], reason: "H1 close below zone level" };
    }

    // 1. CONFIRMED — previous candle body already crossed level upward
    if (bodyBottom(prev) < zoneLevel && bodyTop(prev) > zoneLevel && isBullish(prev)) {
      signals.push({ type: "CONFIRMED", strength: 3, description: "H1 candle already broke level upward" });
    }

    // 2. PINBAR (bullish)
    if (lowerShadow(latest) >= CONFIG.pinbarMinShadowRatio * bodySize(latest)
      && lowerShadow(latest) >= upperShadow(latest)
      && candleRange(latest) > 0
      && bodySize(latest) / candleRange(latest) <= CONFIG.pinbarMaxBodyPct) {
      signals.push({ type: "PINBAR", strength: 2, description: `Bullish pinbar: lower wick ${lowerShadow(latest).toFixed(2)}, body ${bodySize(latest).toFixed(2)}` });
    }

    // 3. ENGULFING (bullish)
    if (isBullish(latest) && isBearish(prev)
      && bodyTop(latest) >= bodyTop(prev)
      && bodyBottom(latest) <= bodyBottom(prev)) {
      signals.push({ type: "ENGULFING", strength: 2, description: "Bullish engulfing: current bull engulfs previous bear" });
    }

  } else {
    // SELL signals: Resistance / SBR zone
    // Prerequisite: H1 close below zone level
    if (latest.close > zoneLevel + pips(CONFIG.touchTolerancePips)) {
      return { zone, signals: [], reason: "H1 close above zone level" };
    }

    // 1. CONFIRMED — previous candle body crossed level downward
    if (bodyTop(prev) > zoneLevel && bodyBottom(prev) < zoneLevel && isBearish(prev)) {
      signals.push({ type: "CONFIRMED", strength: 3, description: "H1 candle already broke level downward" });
    }

    // 2. PINBAR (bearish)
    if (upperShadow(latest) >= CONFIG.pinbarMinShadowRatio * bodySize(latest)
      && upperShadow(latest) >= lowerShadow(latest)
      && candleRange(latest) > 0
      && bodySize(latest) / candleRange(latest) <= CONFIG.pinbarMaxBodyPct) {
      signals.push({ type: "PINBAR", strength: 2, description: `Bearish pinbar: upper wick ${upperShadow(latest).toFixed(2)}, body ${bodySize(latest).toFixed(2)}` });
    }

    // 3. ENGULFING (bearish)
    if (isBearish(latest) && isBullish(prev)
      && bodyTop(latest) >= bodyTop(prev)
      && bodyBottom(latest) <= bodyBottom(prev)) {
      signals.push({ type: "ENGULFING", strength: 2, description: "Bearish engulfing: current bear engulfs previous bull" });
    }
  }

  return {
    zone,
    signals,
    reason: signals.length > 0 ? null : "No H1 signal pattern detected",
  };
}

// ═══════════════════════════════════════════
//  ORDER PARAMETERS
// ═══════════════════════════════════════════
function buildOrderParams(zone, signal, spread, currentPrice) {
  const sl = pips(CONFIG.slPips);
  const tp = pips(CONFIG.tpPips);

  if (zone.direction === "BUY") {
    // BUY LIMIT at zone level. If price already passed, entry at ask - 2 pips
    const entry = zone.level > currentPrice ? zone.level : currentPrice - pips(2);
    return {
      symbol: CONFIG.symbol,
      type: "BUY",
      direction: "BUY",
      entryLevel: +entry.toFixed(2),
      sl: +(entry - sl).toFixed(2),
      tp: +(entry + tp).toFixed(2),
      volume: CONFIG.lotSize,
      rrRatio: "1:2",
      orderType: "BUY LIMIT",
      signalType: signal.type,
      zoneType: zone.type,
      zoneLevel: zone.level,
      comment: `Midas-LB:${zone.type}@${zone.level}`,
    };
  } else {
    // SELL LIMIT at zone level. If price already passed, entry at bid + 2 pips
    const entry = zone.level < currentPrice ? zone.level : currentPrice + pips(2);
    return {
      symbol: CONFIG.symbol,
      type: "SELL",
      direction: "SELL",
      entryLevel: +entry.toFixed(2),
      sl: +(entry + sl).toFixed(2),
      tp: +(entry - tp).toFixed(2),
      volume: CONFIG.lotSize,
      rrRatio: "1:2",
      orderType: "SELL LIMIT",
      signalType: signal.type,
      zoneType: zone.type,
      zoneLevel: zone.level,
      comment: `Midas-LB:${zone.type}@${zone.level}`,
    };
  }
}

// ═══════════════════════════════════════════
//  TRAILING STOP (Labuu method)
// ═══════════════════════════════════════════
export function getTrailingSL(entryPrice, currentPrice, direction) {
  const profitPips = direction === "BUY"
    ? toPips(currentPrice - entryPrice)
    : toPips(entryPrice - currentPrice);

  if (profitPips <= 0) return null; // No trail on negative

  // Find the appropriate step
  let bestOffset = 0;
  for (const [threshold, offset] of CONFIG.trailingStopSteps) {
    if (profitPips >= threshold) bestOffset = offset;
  }

  if (bestOffset === 0) return null;

  return direction === "BUY"
    ? entryPrice + pips(bestOffset)
    : entryPrice - pips(bestOffset);
}

// ═══════════════════════════════════════════
//  MAIN SCAN FUNCTION
// ═══════════════════════════════════════════
/**
 * Full confluence scan. Returns all zones, signals, and recommended orders.
 * The LLM screen agent uses this as its primary data input.
 *
 * @param {Object} options
 * @param {Function} options.getData - Function that returns {h4, h1, currentPrice, spread}
 * @returns {Object} Scan result
 */
export async function scanConfluenceZones(options = {}) {
  const C = CONFIG;

  // Fetch data via MT5 bridge (or fake data in dry run)
  let h4Candles, h1Candles, currentPrice, spread;

  if (process.env.DRY_RUN === "true") {
    // Dry run: generate fake XAUUSD-like data for testing
    log("scanner", "DRY RUN — using synthetic data");
    const fake = generateSyntheticData();
    h4Candles = fake.h4;
    h1Candles = fake.h1;
    currentPrice = fake.currentPrice;
    spread = fake.spread;
  } else {
    try {
      const [h4, h1, sp] = await Promise.all([
        getOHLCV(C.symbol, "H4", C.h4Lookback),
        getOHLCV(C.symbol, "H1", C.h1Lookback),
        getSpread(C.symbol),
      ]);
      if (!h4?.ok || !h1?.ok) {
        return { ok: false, error: "Failed to fetch OHLCV data", h4, h1 };
      }
      h4Candles = h4.candles;
      h1Candles = h1.candles;
      currentPrice = h4Candles[h4Candles.length - 1]?.close || 0;
      spread = sp?.ok ? sp.spread_pips : 999;
    } catch (e) {
      return { ok: false, error: `MT5 data fetch failed: ${e.message}` };
    }
  }

  if (!h4Candles || h4Candles.length < 20) {
    return { ok: false, error: "Insufficient H4 candles" };
  }
  if (!h1Candles || h1Candles.length < 10) {
    return { ok: false, error: "Insufficient H1 candles" };
  }

  // Step 1: Detect swing points
  const swingHighs = findSwingHighs(h4Candles, C.swingLeft, C.swingRight);
  const swingLows = findSwingLows(h4Candles, C.swingLeft, C.swingRight);

  // Step 2: Classify zones (S, R, SBR, RBS)
  let zones = classifyZones(swingHighs, swingLows, h4Candles, currentPrice);

  // Step 3: Merge nearby zones
  zones = mergeZones(zones);

  // Step 4: Sort by distance from current price, take top N
  zones.sort((a, b) => Math.abs(currentPrice - a.level) - Math.abs(currentPrice - b.level));
  const topZones = zones.slice(0, C.maxZones);

  // Step 5: Detect H1 signals for each zone
  const zoneSignals = [];
  for (const zone of topZones) {
    const result = detectH1Signals(zone, h1Candles, currentPrice);
    zoneSignals.push(result);
  }

  // Step 6: Build order parameters for zones with signals
  const actionableSignals = zoneSignals
    .filter(z => z.signals && z.signals.length > 0)
    .map(z => {
      const bestSignal = z.signals.reduce((a, b) => b.strength > a.strength ? b : a);
      const order = buildOrderParams(z.zone, bestSignal, spread, currentPrice);
      return order;
    });

  // Check spread
  const spreadOk = spread <= C.maxSpreadPips;

  // Summary
  const totalZones = topZones.length;
  const zonesWithSignals = zoneSignals.filter(z => z.signals.length > 0).length;

  const result = {
    ok: true,
    timestamp: new Date().toISOString(),
    symbol: C.symbol,
    currentPrice,
    spread,
    spreadOk,
    scanSummary: {
      swingHighsFound: swingHighs.length,
      swingLowsFound: swingLows.length,
      zonesDetected: totalZones,
      zonesWithSignals,
      actionableSignals: actionableSignals.length,
    },
    zones: topZones.map(z => ({
      level: z.level,
      type: z.type,
      direction: z.direction,
      sources: z.sources,
      distancePips: toPips(Math.abs(currentPrice - z.level)).toFixed(0),
    })),
    zoneSignals: zoneSignals.map(z => ({
      level: z.zone.level,
      type: z.zone.type,
      direction: z.zone.direction,
      hasSignal: z.signals.length > 0,
      signals: z.signals.map(s => ({ type: s.type, strength: s.strength, description: s.description })),
      reason: z.reason || null,
    })),
    actionableSignals,
    // H1 context for LLM
    h1Context: {
      latestCandle: {
        open: h1Candles[h1Candles.length - 1].open,
        high: h1Candles[h1Candles.length - 1].high,
        low: h1Candles[h1Candles.length - 1].low,
        close: h1Candles[h1Candles.length - 1].close,
      },
      prevCandle: {
        open: h1Candles[h1Candles.length - 2].open,
        high: h1Candles[h1Candles.length - 2].high,
        low: h1Candles[h1Candles.length - 2].low,
        close: h1Candles[h1Candles.length - 2].close,
      },
      trend: h1Candles[h1Candles.length - 1].close > h1Candles[0].close ? "bullish" : "bearish",
    },
    config: {
      slPips: C.slPips,
      tpPips: C.tpPips,
      lotSize: C.lotSize,
      maxSpreadPips: C.maxSpreadPips,
      trailingSteps: C.trailingStopSteps,
    },
  };

  return result;
}

// ═══════════════════════════════════════════
//  SYNTHETIC DATA FOR DRY RUN TESTING
// ═══════════════════════════════════════════
function generateSyntheticData() {
  const now = Math.floor(Date.now() / 1000);

  // Simulate realistic XAUUSD with swings creating S/R/SBR/RBS zones
  // H4 candles: trending up with pullbacks creating support zones
  const h4 = [];
  let price = 2600.0;
  // Walk through 100 H4 bars (~16 days) with visible swings
  const h4Path = [
    // Phase 1: Uptrend from 2600 to 2680 (20 bars)
    ...Array(20).fill().map((_, i) => 2600 + i * (80/20) + Math.sin(i*0.5)*5),
    // Phase 2: Pullback to 2640 (15 bars) — creates RBS later
    ...Array(15).fill().map((_, i) => 2680 - i * (40/15) - Math.sin(i*0.7)*3),
    // Phase 3: Rally to 2720 (20 bars) — breaks back above 2680 = RBS!
    ...Array(20).fill().map((_, i) => 2640 + i * (80/20) + Math.sin(i*0.4)*6),
    // Phase 4: Big drop to 2650 (15 bars) — breaks below 2700 = SBR!
    ...Array(15).fill().map((_, i) => 2720 - i * (70/15) - Math.sin(i*0.6)*5),
    // Phase 5: Recovery to 2675, then sideways (30 bars)
    ...Array(15).fill().map((_, i) => 2650 + i * (25/15) + Math.sin(i*0.8)*4),
    ...Array(15).fill().map((_, i) => 2675 + Math.sin(i*0.9)*8),
  ];

  for (let i = 0; i < 100 && i < h4Path.length; i++) {
    const open = +price.toFixed(2);
    const close = +h4Path[i].toFixed(2);
    const high = +(Math.max(open, close) + Math.random() * 3).toFixed(2);
    const low = +(Math.min(open, close) - Math.random() * 3).toFixed(2);
    h4.push({
      time: now - (100 - i) * 14400,
      open, high, low, close,
      tick_volume: Math.floor(Math.random() * 5000 + 2000),
      spread: 28,
    });
    price = close;
  }

  const lastH4Close = h4[h4.length - 1].close;

  // H1: 190 random candles + 10 carefully crafted for signals
  const h1 = [];
  for (let i = 0; i < 190; i++) {
    const o = +(2670 + Math.sin(i * 0.1) * 20 + Math.random() * 2).toFixed(2);
    const c = +(o + (Math.random() - 0.5) * 4).toFixed(2);
    const h = +(Math.max(o, c) + Math.random() * 1.5).toFixed(2);
    const l = +(Math.min(o, c) - Math.random() * 1.5).toFixed(2);
    h1.push({ time: now - (200 - i) * 3600, open: o, high: h, low: l, close: c, tick_volume: 1000, spread: 28 });
  }

  // Last 10 candles: create a bullish engulfing pattern near S @ 2640 zone
  // Price drops toward zone, then reverses hard
  const signalCandles = [
    // Price approaching zone from above
    { open: 2665, high: 2668, low: 2663, close: 2663 }, // slight bear
    { open: 2663, high: 2665, low: 2658, close: 2660 }, // bear
    { open: 2660, high: 2661, low: 2655, close: 2656 }, // bear
    { open: 2656, high: 2658, low: 2650, close: 2651 }, // bear down to zone
    { open: 2651, high: 2653, low: 2648, close: 2649 }, // near zone level
    { open: 2649, high: 2650, low: 2641, close: 2643 }, // drops below zone (!)
    { open: 2643, high: 2646, low: 2637, close: 2638 }, // bear — prev candle before engulfing (small bear body)
    // === ENGULFING ===
    { open: 2647, high: 2651, low: 2638, close: 2640 }, // prev: clear bear near zone
    { open: 2639, high: 2653, low: 2637, close: 2652 }, // latest: BIG bull engulfing — engulfs prev! body: 2638→2647, prev: 2639→2639
  ];

  for (let i = 0; i < signalCandles.length; i++) {
    h1.push({
      time: now - (signalCandles.length - i) * 3600,
      ...signalCandles[i],
      tick_volume: Math.floor(800 + Math.abs(signalCandles[i].close - signalCandles[i].open) * 200),
      spread: 28,
    });
  }

  const currentPrice = h1[h1.length - 1].close;
  return { h4, h1, currentPrice, spread: 28 };
}

export { toPips, pips };
