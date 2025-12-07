import { subscribeToPrice, unsubscribeFromPrice, initRealtimePriceService } from "./realtimePriceService.js";
import { logEvent } from "./databaseService.js";
import { TRAILING_STOP_LOSS_PERCENT } from "../config.js";
import { getTrailingPercentForRisk } from "../utils/helpers.js";

const trailingStops = new Map();
const unsubscribeFunctions = new Map();

export async function initTrailingStopService() {
  await initRealtimePriceService();
  await logEvent("INFO", "Real-time trailing stop-loss service initialized");
}

export function startTrailingStopMonitor(mintAddress, purchasePrice, riskLevel, onTrigger, dexSource = null) {
  const trailingPercent = getTrailingPercentForRisk(riskLevel, TRAILING_STOP_LOSS_PERCENT);

  const state = {
    mintAddress,
    purchasePrice,
    riskLevel,
    trailingPercent,
    highestPriceSeen: purchasePrice,
    isActive: true,
    startTime: Date.now(),
    lastUpdate: Date.now(),
    priceHistory: [],
    dexSource,
  };

  trailingStops.set(mintAddress, state);

  const unsubscribe = subscribeToPrice(
    mintAddress,
    async (mint, newPrice, oldPrice) => {
      await handlePriceUpdate(mint, newPrice, onTrigger);
    },
    dexSource
  );

  unsubscribeFunctions.set(mintAddress, unsubscribe);

  logEvent("INFO", `Started real-time trailing stop monitor for ${mintAddress}`, {
    purchasePrice,
    riskLevel,
    trailingPercent: `${trailingPercent}%`,
  });

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

async function handlePriceUpdate(mintAddress, currentPrice, onTrigger) {
  const state = trailingStops.get(mintAddress);
  if (!state || !state.isActive) return;

  state.lastUpdate = Date.now();

  state.priceHistory.push({ price: currentPrice, time: Date.now() });
  if (state.priceHistory.length > 10) {
    state.priceHistory.shift();
  }

  if (currentPrice > state.highestPriceSeen) {
    state.highestPriceSeen = currentPrice;
    await logEvent("INFO", `New high for ${mintAddress}: ${currentPrice.toFixed(10)} SOL`);
  }

  const pnlPercentage = ((currentPrice - state.purchasePrice) / state.purchasePrice) * 100;
  const dropFromPeak = ((state.highestPriceSeen - currentPrice) / state.highestPriceSeen) * 100;

  if (pnlPercentage > 0 && dropFromPeak >= state.trailingPercent) {
    state.isActive = false;

    await logEvent("WARN", `REAL-TIME TRAILING STOP TRIGGERED for ${mintAddress}`, {
      currentPrice,
      purchasePrice: state.purchasePrice,
      highestPrice: state.highestPriceSeen,
      pnlPercent: `${pnlPercentage.toFixed(2)}%`,
      dropFromPeak: `${dropFromPeak.toFixed(2)}%`,
      trailingPercent: `${state.trailingPercent}%`,
      riskLevel: state.riskLevel,
      timeHeld: `${((Date.now() - state.startTime) / 1000).toFixed(1)}s`,
    });

    if (onTrigger) {
      await onTrigger(mintAddress, currentPrice, "TRAILING_STOP");
    }

    stopTrailingStopMonitor(mintAddress);
    return;
  }

  if (pnlPercentage <= -10) {
    state.isActive = false;

    await logEvent("WARN", `REAL-TIME HARD STOP-LOSS TRIGGERED for ${mintAddress}`, {
      currentPrice,
      purchasePrice: state.purchasePrice,
      pnlPercent: `${pnlPercentage.toFixed(2)}%`,
      riskLevel: state.riskLevel,
    });

    if (onTrigger) {
      await onTrigger(mintAddress, currentPrice, "HARD_STOP");
    }

    stopTrailingStopMonitor(mintAddress);
    return;
  }

  if (currentPrice === 0) {
    state.isActive = false;

    await logEvent("WARN", `ZERO PRICE DETECTED for ${mintAddress} - Emergency sell`, {
      riskLevel: state.riskLevel,
    });

    if (onTrigger) {
      await onTrigger(mintAddress, currentPrice, "ZERO_PRICE");
    }

    stopTrailingStopMonitor(mintAddress);
    return;
  }
}

export function stopTrailingStopMonitor(mintAddress) {
  const state = trailingStops.get(mintAddress);
  if (state) {
    state.isActive = false;
  }

  const unsubscribe = unsubscribeFunctions.get(mintAddress);
  if (unsubscribe) {
    unsubscribe();
    unsubscribeFunctions.delete(mintAddress);
  }

  trailingStops.delete(mintAddress);
  unsubscribeFromPrice(mintAddress);

  logEvent("INFO", `Stopped trailing stop monitor for ${mintAddress}`);
}

export function getTrailingStopState(mintAddress) {
  return trailingStops.get(mintAddress);
}

export function getAllActiveMonitors() {
  return new Map(trailingStops);
}

export function isBeingMonitored(mintAddress) {
  const state = trailingStops.get(mintAddress);
  return state && state.isActive;
}

export function updatePurchasePrice(mintAddress, newPurchasePrice) {
  const state = trailingStops.get(mintAddress);
  if (state) {
    state.purchasePrice = newPurchasePrice;
    logEvent("INFO", `Updated purchase price for ${mintAddress} to ${newPurchasePrice}`);
  }
}

export function shutdownAllMonitors() {
  for (const mintAddress of trailingStops.keys()) {
    stopTrailingStopMonitor(mintAddress);
  }
  logEvent("INFO", "All trailing stop monitors shut down");
}

export function getActiveMonitorCount() {
  let count = 0;
  for (const state of trailingStops.values()) {
    if (state.isActive) count++;
  }
  return count;
}
