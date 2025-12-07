/**
 * Real-Time Creator Wallet Monitoring Service
 *
 * Uses WebSocket subscription (onAccountChange) for INSTANT detection
 * when creator sells tokens - much faster than polling.
 *
 * The moment creator's token balance changes, we get notified and can
 * trigger emergency sell within milliseconds.
 *
 * References:
 * - https://www.helius.dev/docs/enhanced-websockets
 * - https://solana.com/docs/rpc/websocket/accountsubscribe
 * - https://www.helius.dev/blog/solana-data-streaming
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { connection } from "./solanaService.js";
import { logEvent } from "./databaseService.js";

// Configuration - AGGRESSIVE thresholds to beat other bots
const CREATOR_SELL_THRESHOLD_PERCENT = 5; // Alert if creator sells more than 5%
const CREATOR_DUMP_THRESHOLD_PERCENT = 15; // Emergency sell if creator dumps more than 15%
const MAX_MONITOR_DURATION_MS = 30 * 60 * 1000; // Monitor for 30 minutes max

// Active monitors: Map<mintAddress, MonitorState>
const activeMonitors = new Map();

/**
 * Start monitoring a creator wallet for a specific token using WebSocket
 * This provides INSTANT notification when creator's balance changes
 */
export async function startCreatorMonitor(mintAddress, creatorAddress, onDumpDetected = null) {
  if (!creatorAddress) {
    await logEvent("WARN", `Cannot monitor creator - address not provided`, { mint: mintAddress });
    return false;
  }

  if (activeMonitors.has(mintAddress)) {
    await logEvent("INFO", `Creator monitor already active for ${mintAddress}`);
    return true;
  }

  try {
    const creatorPubKey = new PublicKey(creatorAddress);
    const mintPubKey = new PublicKey(mintAddress);

    // Get creator's token account address (ATA)
    const creatorTokenAccount = await getAssociatedTokenAddress(mintPubKey, creatorPubKey);

    // Get initial balance
    let initialBalance = 0;
    try {
      const tokenAccountInfo = await connection.getParsedAccountInfo(creatorTokenAccount);
      if (tokenAccountInfo.value?.data?.parsed?.info?.tokenAmount?.amount) {
        initialBalance = parseInt(tokenAccountInfo.value.data.parsed.info.tokenAmount.amount, 10);
      }
    } catch (e) {
      // Creator might not have ATA yet, try getParsedTokenAccountsByOwner
      const accounts = await connection.getParsedTokenAccountsByOwner(creatorPubKey, { mint: mintPubKey });
      if (accounts.value.length > 0) {
        initialBalance = parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount, 10);
      }
    }

    if (initialBalance === 0) {
      await logEvent("INFO", `Creator has no tokens to monitor`, {
        mint: mintAddress,
        creator: creatorAddress
      });
      return false;
    }

    await logEvent("INFO", `🔍 Starting REAL-TIME creator monitor (WebSocket)`, {
      mint: mintAddress,
      creator: creatorAddress.slice(0, 8) + "...",
      initialBalance: initialBalance.toLocaleString(),
      creatorATA: creatorTokenAccount.toString().slice(0, 8) + "...",
    });

    // Subscribe to creator's token account changes via WebSocket
    // This triggers INSTANTLY when balance changes - no polling delay!
    const subscriptionId = connection.onAccountChange(
      creatorTokenAccount,
      async (accountInfo, context) => {
        await handleAccountChange(mintAddress, accountInfo, context);
      },
      { commitment: "confirmed" }
    );

    // Store monitor state
    const monitorState = {
      creatorAddress,
      creatorPubKey,
      mintPubKey,
      creatorTokenAccount,
      initialBalance,
      lastKnownBalance: initialBalance,
      subscriptionId,
      startTime: Date.now(),
      totalSoldPercent: 0,
      onDumpDetected,
    };
    activeMonitors.set(mintAddress, monitorState);

    // Auto-stop after max duration
    const timeoutId = setTimeout(() => {
      stopCreatorMonitor(mintAddress, "Max monitoring duration reached");
    }, MAX_MONITOR_DURATION_MS);
    monitorState.timeoutId = timeoutId;

    return true;
  } catch (error) {
    await logEvent("ERROR", `Failed to start creator monitor`, {
      mint: mintAddress,
      creator: creatorAddress,
      error: error.message,
    });
    return false;
  }
}

/**
 * Handle real-time account change notification
 * This is called INSTANTLY when creator's token balance changes
 */
async function handleAccountChange(mintAddress, accountInfo, context) {
  const monitor = activeMonitors.get(mintAddress);
  if (!monitor) return;

  try {
    // Parse the new balance from account data
    let currentBalance = 0;

    if (accountInfo.data) {
      // For parsed account info
      if (typeof accountInfo.data === 'object' && accountInfo.data.parsed) {
        currentBalance = parseInt(accountInfo.data.parsed.info.tokenAmount.amount, 10);
      } else {
        // For raw buffer data, we need to parse SPL token account
        // Token account data: 165 bytes, amount is at offset 64, 8 bytes little-endian
        const data = accountInfo.data;
        if (data.length >= 72) {
          currentBalance = Number(data.readBigUInt64LE(64));
        }
      }
    }

    const previousBalance = monitor.lastKnownBalance;
    const initialBalance = monitor.initialBalance;

    // Check if creator sold tokens
    if (currentBalance < previousBalance) {
      const soldAmount = previousBalance - currentBalance;
      const soldPercentFromInitial = (soldAmount / initialBalance) * 100;
      const totalSoldPercent = ((initialBalance - currentBalance) / initialBalance) * 100;

      monitor.lastKnownBalance = currentBalance;
      monitor.totalSoldPercent = totalSoldPercent;

      const detectionLatency = Date.now() - monitor.startTime;

      await logEvent("WARN", `⚠️ CREATOR SELLING DETECTED (instant)!`, {
        mint: mintAddress,
        soldAmount: soldAmount.toLocaleString(),
        soldPercent: soldPercentFromInitial.toFixed(2) + "%",
        totalSoldPercent: totalSoldPercent.toFixed(2) + "%",
        remainingBalance: currentBalance.toLocaleString(),
        detectionLatencyMs: detectionLatency,
        slot: context.slot,
      });

      // Check if dump threshold exceeded - TRIGGER EMERGENCY SELL
      if (totalSoldPercent >= CREATOR_DUMP_THRESHOLD_PERCENT) {
        await logEvent("ERROR", `🚨 CREATOR DUMP DETECTED! Sold ${totalSoldPercent.toFixed(1)}% - EMERGENCY SELL!`, {
          mint: mintAddress,
          totalSoldPercent: totalSoldPercent.toFixed(2) + "%",
          threshold: CREATOR_DUMP_THRESHOLD_PERCENT + "%",
        });

        // Trigger emergency sell callback
        if (monitor.onDumpDetected) {
          // Don't await - fire and continue to not block
          monitor.onDumpDetected(mintAddress, totalSoldPercent).catch(e => {
            logEvent("ERROR", `Emergency sell failed: ${e.message}`, { mint: mintAddress });
          });
        }

        // Stop monitoring
        await stopCreatorMonitor(mintAddress, "Dump detected - emergency sell triggered");
        return;
      }

      // Alert for significant sells below dump threshold
      if (soldPercentFromInitial >= CREATOR_SELL_THRESHOLD_PERCENT) {
        await logEvent("WARN", `⚡ Creator sold ${soldPercentFromInitial.toFixed(1)}% - monitoring closely!`, {
          mint: mintAddress,
        });
      }
    } else if (currentBalance > previousBalance) {
      // Creator received more tokens (unlikely but track it)
      monitor.lastKnownBalance = currentBalance;
      await logEvent("INFO", `Creator received tokens`, {
        mint: mintAddress,
        newBalance: currentBalance.toLocaleString(),
      });
    }
  } catch (error) {
    await logEvent("ERROR", `Error handling account change`, {
      mint: mintAddress,
      error: error.message,
    });
  }
}

/**
 * Stop monitoring a creator wallet
 */
export async function stopCreatorMonitor(mintAddress, reason = "Manual stop") {
  const monitor = activeMonitors.get(mintAddress);
  if (!monitor) return;

  // Unsubscribe from WebSocket
  if (monitor.subscriptionId !== undefined) {
    try {
      await connection.removeAccountChangeListener(monitor.subscriptionId);
    } catch (e) {
      // Ignore unsubscribe errors
    }
  }

  // Clear timeout
  if (monitor.timeoutId) {
    clearTimeout(monitor.timeoutId);
  }

  activeMonitors.delete(mintAddress);

  await logEvent("INFO", `Stopped creator monitor: ${reason}`, {
    mint: mintAddress,
    totalSoldPercent: monitor.totalSoldPercent?.toFixed(2) + "%",
    monitorDurationMs: Date.now() - monitor.startTime,
  });
}

/**
 * Check if a token is being monitored
 */
export function isMonitoring(mintAddress) {
  return activeMonitors.has(mintAddress);
}

/**
 * Get all active monitors
 */
export function getActiveMonitors() {
  const monitors = [];
  for (const [mint, monitor] of activeMonitors.entries()) {
    monitors.push({
      mint,
      creator: monitor.creatorAddress,
      totalSoldPercent: monitor.totalSoldPercent,
      monitoringForMs: Date.now() - monitor.startTime,
    });
  }
  return monitors;
}

/**
 * Stop all monitors (cleanup)
 */
export async function stopAllMonitors() {
  for (const mintAddress of activeMonitors.keys()) {
    await stopCreatorMonitor(mintAddress, "Cleanup - stopping all monitors");
  }
}

export default {
  startCreatorMonitor,
  stopCreatorMonitor,
  isMonitoring,
  getActiveMonitors,
  stopAllMonitors,
};
