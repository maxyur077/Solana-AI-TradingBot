import ReconnectingWebSocket from "reconnecting-websocket";
import WebSocket from "ws";
import { logEvent } from "./databaseService.js";
import { SOL_MINT, REALTIME_PRICE_POLL_INTERVAL_MS } from "../config.js";
import { getTokenPriceInSol } from "./solanaService.js";
import { getMeteoraTokenPrice } from "./meteoraSwapService.js";

// Price cache for all monitored tokens
const priceCache = new Map();

// Callbacks registered for price updates
const priceCallbacks = new Map();

// Track which tokens are from Meteora (for pricing)
const meteoraTokens = new Set();

// WebSocket connection
let ws = null;
let isConnected = false;

// Tokens currently being monitored
const monitoredTokens = new Set();

// Birdeye WebSocket URL (free tier supports price updates)
const BIRDEYE_WS_URL = "wss://public-api.birdeye.so/socket";

// Jupiter price polling (configurable, default 2 seconds)
let pollingInterval = null;
const POLLING_INTERVAL_MS = REALTIME_PRICE_POLL_INTERVAL_MS;

/**
 * Initialize the real-time price service
 */
export async function initRealtimePriceService() {
  await logEvent("INFO", "Initializing real-time price monitoring service...");

  // Start with polling-based approach (more reliable for meme coins)
  startPricePolling();

  await logEvent("SUCCESS", "Real-time price service initialized (polling mode: 2s interval)");
}

/**
 * Start polling prices at high frequency
 */
function startPricePolling() {
  if (pollingInterval) return;

  pollingInterval = setInterval(async () => {
    if (monitoredTokens.size === 0) return;

    for (const mintAddress of monitoredTokens) {
      try {
        let price = 0;

        // Use Meteora pricing for Meteora tokens, Jupiter for others
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
  }, POLLING_INTERVAL_MS);
}

/**
 * Stop price polling
 */
function stopPricePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Update price and trigger callbacks
 */
function updatePrice(mintAddress, newPrice) {
  const oldPrice = priceCache.get(mintAddress);
  priceCache.set(mintAddress, {
    price: newPrice,
    timestamp: Date.now(),
  });

  // Trigger all registered callbacks for this token
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

/**
 * Subscribe to price updates for a token
 * @param {string} mintAddress - Token mint address
 * @param {Function} callback - Called on each price update: (mintAddress, newPrice, oldPrice) => void
 * @param {string} dexSource - Optional DEX source (e.g., "meteora" for Meteora tokens)
 * @returns {Function} Unsubscribe function
 */
export function subscribeToPrice(mintAddress, callback, dexSource = null) {
  // Add to monitored tokens
  monitoredTokens.add(mintAddress);

  // Track if this is a Meteora token for correct pricing
  if (dexSource === "meteora") {
    meteoraTokens.add(mintAddress);
  }

  // Register callback
  if (!priceCallbacks.has(mintAddress)) {
    priceCallbacks.set(mintAddress, new Set());
  }
  priceCallbacks.get(mintAddress).add(callback);

  logEvent("INFO", `Subscribed to real-time price updates for ${mintAddress}`);

  // Return unsubscribe function
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

/**
 * Unsubscribe from all price updates for a token
 * @param {string} mintAddress - Token mint address
 */
export function unsubscribeFromPrice(mintAddress) {
  monitoredTokens.delete(mintAddress);
  meteoraTokens.delete(mintAddress);
  priceCallbacks.delete(mintAddress);
  priceCache.delete(mintAddress);
  logEvent("INFO", `Unsubscribed from price updates for ${mintAddress}`);
}

/**
 * Get cached price for a token
 * @param {string} mintAddress - Token mint address
 * @returns {number|null} Current price or null if not cached
 */
export function getCachedPrice(mintAddress) {
  const cached = priceCache.get(mintAddress);
  return cached ? cached.price : null;
}

/**
 * Get all monitored tokens
 * @returns {Set<string>} Set of mint addresses
 */
export function getMonitoredTokens() {
  return new Set(monitoredTokens);
}

/**
 * Check if service is actively monitoring
 * @returns {boolean}
 */
export function isMonitoring() {
  return pollingInterval !== null || isConnected;
}

/**
 * Shutdown the price service
 */
export function shutdownPriceService() {
  stopPricePolling();
  if (ws) {
    ws.close();
    ws = null;
  }
  monitoredTokens.clear();
  priceCallbacks.clear();
  priceCache.clear();
  isConnected = false;
  logEvent("INFO", "Real-time price service shut down");
}
