import { subscribeToPrice, unsubscribeFromPrice, initRealtimePriceService } from "./realtimePriceService.js";
import { logEvent } from "./databaseService.js";
import { TRAILING_STOP_LOSS_PERCENT } from "../config.js";

// Active trailing stop monitors
const trailingStops = new Map();

// Unsubscribe functions for each token
const unsubscribeFunctions = new Map();

/**
 * Initialize the real-time trailing stop service
 */
export async function initTrailingStopService() {
  await initRealtimePriceService();
  await logEvent("INFO", "Real-time trailing stop-loss service initialized");
}

/**
 * Start monitoring a position for trailing stop-loss
 * @param {string} mintAddress - Token mint address
 * @param {number} purchasePrice - Original purchase price in SOL
 * @param {string} riskLevel - GOOD, WARNING, or DANGER
 * @param {Function} onTrigger - Callback when stop-loss triggers: (mintAddress, currentPrice, reason) => void
 * @param {string} dexSource - Optional DEX source (e.g., "meteora" for Meteora tokens)
 * @returns {Object} Monitor control object with stop() method
 */
export function startTrailingStopMonitor(mintAddress, purchasePrice, riskLevel, onTrigger, dexSource = null) {
  // Calculate trailing stop percentage based on risk level
  const trailingPercent = getTrailingPercentForRisk(riskLevel);

  // Initialize trailing stop state
  const state = {
    mintAddress,
    purchasePrice,
    riskLevel,
    trailingPercent,
    highestPriceSeen: purchasePrice,
    isActive: true,
    startTime: Date.now(),
    lastUpdate: Date.now(),
    priceHistory: [], // Keep last 10 prices for analysis
    dexSource,
  };

  trailingStops.set(mintAddress, state);

  // Subscribe to real-time price updates (pass dexSource for correct pricing)
  const unsubscribe = subscribeToPrice(mintAddress, async (mint, newPrice, oldPrice) => {
    await handlePriceUpdate(mint, newPrice, onTrigger);
  }, dexSource);

  unsubscribeFunctions.set(mintAddress, unsubscribe);

  logEvent("INFO", `Started real-time trailing stop monitor for ${mintAddress}`, {
    purchasePrice,
    riskLevel,
    trailingPercent: `${trailingPercent}%`,
  });

  // Return control object
  return {
    stop: () => stopTrailingStopMonitor(mintAddress),
    getState: () => trailingStops.get(mintAddress),
    updateHighest: (price) => {
      const s = trailingStops.get(mintAddress);
      if (s && price > s.highestPriceSeen) {
        s.highestPriceSeen = price;
      }
    },
  };
}

/**
 * Get trailing stop percentage based on risk level
 * Tighter stops for riskier positions
 */
function getTrailingPercentForRisk(riskLevel) {
  switch (riskLevel) {
    case "DANGER":
      return Math.max(TRAILING_STOP_LOSS_PERCENT - 2, 3); // Tighter: 3%
    case "WARNING":
      return Math.max(TRAILING_STOP_LOSS_PERCENT - 1, 4); // Medium: 4%
    case "GOOD":
    default:
      return TRAILING_STOP_LOSS_PERCENT; // Default: 5%
  }
}

/**
 * Handle real-time price update for trailing stop logic
 */
async function handlePriceUpdate(mintAddress, currentPrice, onTrigger) {
  const state = trailingStops.get(mintAddress);
  if (!state || !state.isActive) return;

  state.lastUpdate = Date.now();

  // Update price history (keep last 10)
  state.priceHistory.push({ price: currentPrice, time: Date.now() });
  if (state.priceHistory.length > 10) {
    state.priceHistory.shift();
  }

  // Update highest price seen
  if (currentPrice > state.highestPriceSeen) {
    state.highestPriceSeen = currentPrice;
    await logEvent("INFO", `New high for ${mintAddress}: ${currentPrice.toFixed(10)} SOL`, {
      previousHigh: state.highestPriceSeen,
    });
  }

  // Calculate P&L and drop from peak
  const pnlPercentage = ((currentPrice - state.purchasePrice) / state.purchasePrice) * 100;
  const dropFromPeak = ((state.highestPriceSeen - currentPrice) / state.highestPriceSeen) * 100;

  // TRAILING STOP-LOSS CHECK
  // Only trigger if we're in profit AND dropped from peak
  if (pnlPercentage > 0 && dropFromPeak >= state.trailingPercent) {
    state.isActive = false;

    await logEvent(
      "WARN",
      `REAL-TIME TRAILING STOP TRIGGERED for ${mintAddress}`,
      {
        currentPrice,
        purchasePrice: state.purchasePrice,
        highestPrice: state.highestPriceSeen,
        pnlPercent: `${pnlPercentage.toFixed(2)}%`,
        dropFromPeak: `${dropFromPeak.toFixed(2)}%`,
        trailingPercent: `${state.trailingPercent}%`,
        riskLevel: state.riskLevel,
        timeHeld: `${((Date.now() - state.startTime) / 1000).toFixed(1)}s`,
      }
    );

    // Trigger the callback (this will execute the sell)
    if (onTrigger) {
      await onTrigger(mintAddress, currentPrice, "TRAILING_STOP");
    }

    // Clean up
    stopTrailingStopMonitor(mintAddress);
    return;
  }

  // HARD STOP-LOSS CHECK (-10%)
  if (pnlPercentage <= -10) {
    state.isActive = false;

    await logEvent(
      "WARN",
      `REAL-TIME HARD STOP-LOSS TRIGGERED for ${mintAddress}`,
      {
        currentPrice,
        purchasePrice: state.purchasePrice,
        pnlPercent: `${pnlPercentage.toFixed(2)}%`,
        riskLevel: state.riskLevel,
      }
    );

    if (onTrigger) {
      await onTrigger(mintAddress, currentPrice, "HARD_STOP");
    }

    stopTrailingStopMonitor(mintAddress);
    return;
  }

  // ZERO PRICE CHECK
  if (currentPrice === 0) {
    state.isActive = false;

    await logEvent(
      "WARN",
      `ZERO PRICE DETECTED for ${mintAddress} - Emergency sell`,
      { riskLevel: state.riskLevel }
    );

    if (onTrigger) {
      await onTrigger(mintAddress, currentPrice, "ZERO_PRICE");
    }

    stopTrailingStopMonitor(mintAddress);
    return;
  }
}

/**
 * Stop monitoring a position
 */
export function stopTrailingStopMonitor(mintAddress) {
  const state = trailingStops.get(mintAddress);
  if (state) {
    state.isActive = false;
  }

  // Unsubscribe from price updates
  const unsubscribe = unsubscribeFunctions.get(mintAddress);
  if (unsubscribe) {
    unsubscribe();
    unsubscribeFunctions.delete(mintAddress);
  }

  trailingStops.delete(mintAddress);
  unsubscribeFromPrice(mintAddress);

  logEvent("INFO", `Stopped trailing stop monitor for ${mintAddress}`);
}

/**
 * Get current state of a trailing stop monitor
 */
export function getTrailingStopState(mintAddress) {
  return trailingStops.get(mintAddress);
}

/**
 * Get all active trailing stop monitors
 */
export function getAllActiveMonitors() {
  return new Map(trailingStops);
}

/**
 * Check if a position is being monitored
 */
export function isBeingMonitored(mintAddress) {
  const state = trailingStops.get(mintAddress);
  return state && state.isActive;
}

/**
 * Update purchase price (useful if averaging in)
 */
export function updatePurchasePrice(mintAddress, newPurchasePrice) {
  const state = trailingStops.get(mintAddress);
  if (state) {
    state.purchasePrice = newPurchasePrice;
    logEvent("INFO", `Updated purchase price for ${mintAddress} to ${newPurchasePrice}`);
  }
}

/**
 * Shutdown all monitors
 */
export function shutdownAllMonitors() {
  for (const mintAddress of trailingStops.keys()) {
    stopTrailingStopMonitor(mintAddress);
  }
  logEvent("INFO", "All trailing stop monitors shut down");
}
