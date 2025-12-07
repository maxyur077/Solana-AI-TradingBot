import { logEvent } from "./databaseService.js";
import { REALTIME_PRICE_POLL_INTERVAL_MS } from "../config.js";
import { getTokenPriceInSol } from "./solanaService.js";
import { getMeteoraTokenPrice } from "./meteoraSwapService.js";

const priceCache = new Map();
const priceCallbacks = new Map();
const meteoraTokens = new Set();
const monitoredTokens = new Set();

let pollingInterval = null;

export async function initRealtimePriceService() {
  await logEvent("INFO", "Initializing real-time price monitoring service...");
  startPricePolling();
  await logEvent("SUCCESS", `Real-time price service initialized (polling mode: ${REALTIME_PRICE_POLL_INTERVAL_MS}ms interval)`);
}

function startPricePolling() {
  if (pollingInterval) return;

  pollingInterval = setInterval(async () => {
    if (monitoredTokens.size === 0) return;

    for (const mintAddress of monitoredTokens) {
      try {
        let price = 0;

        if (meteoraTokens.has(mintAddress)) {
          price = await getMeteoraTokenPrice(mintAddress);
        } else {
          price = await getTokenPriceInSol(mintAddress);
        }

        if (price > 0) {
          updatePrice(mintAddress, price);
        }
      } catch (error) {
        // Silent fail - will retry next interval
      }
    }
  }, REALTIME_PRICE_POLL_INTERVAL_MS);
}

function stopPricePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function updatePrice(mintAddress, newPrice) {
  const oldPrice = priceCache.get(mintAddress);
  priceCache.set(mintAddress, {
    price: newPrice,
    timestamp: Date.now(),
  });

  const callbacks = priceCallbacks.get(mintAddress);
  if (callbacks) {
    for (const callback of callbacks) {
      try {
        callback(mintAddress, newPrice, oldPrice?.price);
      } catch (error) {
        // Don't let callback errors break the price feed
      }
    }
  }
}

export function subscribeToPrice(mintAddress, callback, dexSource = null) {
  monitoredTokens.add(mintAddress);

  if (dexSource === "meteora") {
    meteoraTokens.add(mintAddress);
  }

  if (!priceCallbacks.has(mintAddress)) {
    priceCallbacks.set(mintAddress, new Set());
  }
  priceCallbacks.get(mintAddress).add(callback);

  logEvent("INFO", `Subscribed to real-time price updates for ${mintAddress}`);

  return () => {
    const callbacks = priceCallbacks.get(mintAddress);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        priceCallbacks.delete(mintAddress);
        monitoredTokens.delete(mintAddress);
        meteoraTokens.delete(mintAddress);
        priceCache.delete(mintAddress);
      }
    }
  };
}

export function unsubscribeFromPrice(mintAddress) {
  monitoredTokens.delete(mintAddress);
  meteoraTokens.delete(mintAddress);
  priceCallbacks.delete(mintAddress);
  priceCache.delete(mintAddress);
  logEvent("INFO", `Unsubscribed from price updates for ${mintAddress}`);
}

export function getCachedPrice(mintAddress) {
  const cached = priceCache.get(mintAddress);
  return cached ? cached.price : null;
}

export function getMonitoredTokens() {
  return new Set(monitoredTokens);
}

export function isMonitoring() {
  return pollingInterval !== null;
}

export function getMonitoredTokenCount() {
  return monitoredTokens.size;
}

export function shutdownPriceService() {
  stopPricePolling();
  monitoredTokens.clear();
  priceCallbacks.clear();
  priceCache.clear();
  meteoraTokens.clear();
  logEvent("INFO", "Real-time price service shut down");
}
