import { logEvent } from "./databaseService.js";
import { getPortfolioSize } from "./tradeService.js";
import { MAX_PORTFOLIO_SIZE } from "../config.js";

const DEX_ROTATION_ORDER = ["pumpfun", "meteora", "raydium"];

class CoinProcessingQueue {
  constructor() {
    this.queues = {
      pumpfun: null,
      meteora: null,
      raydium: null,
    };
    this.isProcessing = false;
    this.currentRotationIndex = 0;
  }

  async add(signature, mintAddress, transaction, source, poolAddress, processor) {
    const currentPortfolioSize = getPortfolioSize();

    if (currentPortfolioSize >= MAX_PORTFOLIO_SIZE) {
      return;
    }

    const dexType = this.getDexType(source);

    if (this.queues[dexType] !== null) {
      return;
    }

    const queueItem = {
      signature,
      mintAddress,
      transaction,
      source,
      poolAddress,
      processor,
      addedAt: Date.now(),
    };

    this.queues[dexType] = queueItem;

    await logEvent("INFO", `Added coin to ${dexType.toUpperCase()} queue (rotation: pumpfun → meteora → raydium)`, {
      source,
      mintAddress,
      dexType,
      portfolioSize: currentPortfolioSize,
    });

    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  async processQueue() {
    if (this.isProcessing) {
      return;
    }

    if (!this.hasAnyCoins()) {
      return;
    }

    this.isProcessing = true;

    while (this.hasAnyCoins()) {
      const currentPortfolioSize = getPortfolioSize();

      if (currentPortfolioSize >= MAX_PORTFOLIO_SIZE) {
        await logEvent("INFO", `Portfolio full during processing. Clearing all queues`, {
          portfolioSize: currentPortfolioSize,
        });
        this.clearAllQueues();
        break;
      }

      const item = this.getNextCoinByRotation();

      if (!item) {
        break;
      }

      await logEvent("INFO", `Processing coin from ${item.dexType.toUpperCase()} (rotation order)`, {
        source: item.source,
        mintAddress: item.mintAddress,
        nextInRotation: this.getNextDexInRotation(),
        portfolioSize: currentPortfolioSize,
      });

      try {
        await item.processor(
          item.signature,
          item.mintAddress,
          item.transaction,
          item.source,
          item.poolAddress
        );

        await logEvent("SUCCESS", `Completed processing ${item.dexType.toUpperCase()} coin`, {
          source: item.source,
          mintAddress: item.mintAddress,
        });
      } catch (error) {
        await logEvent("ERROR", `Error processing ${item.dexType.toUpperCase()} coin`, {
          source: item.source,
          mintAddress: item.mintAddress,
          error: error.message,
        });
      }

      if (this.hasAnyCoins()) {
        const nextDex = this.getNextDexInRotation();
        await logEvent("INFO", `Next in rotation: ${nextDex.toUpperCase()}`, {
          remainingCoins: this.getTotalQueuedCoins(),
        });
      }
    }

    this.isProcessing = false;
    await logEvent("INFO", "All queues empty");
  }

  getNextCoinByRotation() {
    const maxAttempts = DEX_ROTATION_ORDER.length;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const dexType = DEX_ROTATION_ORDER[this.currentRotationIndex];
      this.currentRotationIndex = (this.currentRotationIndex + 1) % DEX_ROTATION_ORDER.length;

      if (this.queues[dexType] !== null) {
        const item = this.queues[dexType];
        this.queues[dexType] = null;
        return { ...item, dexType };
      }

      attempts++;
    }

    return null;
  }

  getNextDexInRotation() {
    return DEX_ROTATION_ORDER[this.currentRotationIndex];
  }

  hasAnyCoins() {
    return Object.values(this.queues).some(queue => queue !== null);
  }

  getTotalQueuedCoins() {
    return Object.values(this.queues).filter(queue => queue !== null).length;
  }

  clearAllQueues() {
    this.queues = {
      pumpfun: null,
      meteora: null,
      raydium: null,
    };
  }

  getDexType(source) {
    const sourceLower = source.toLowerCase();
    if (sourceLower.includes("pumpfun")) return "pumpfun";
    if (sourceLower.includes("meteora")) return "meteora";
    if (sourceLower.includes("raydium")) return "raydium";
    return "meteora";
  }

  getQueueStatus() {
    return {
      totalQueued: this.getTotalQueuedCoins(),
      isProcessing: this.isProcessing,
      rotationOrder: DEX_ROTATION_ORDER,
      nextDex: this.getNextDexInRotation(),
      queues: {
        pumpfun: this.queues.pumpfun ? {
          mintAddress: this.queues.pumpfun.mintAddress,
          source: this.queues.pumpfun.source,
        } : null,
        meteora: this.queues.meteora ? {
          mintAddress: this.queues.meteora.mintAddress,
          source: this.queues.meteora.source,
        } : null,
        raydium: this.queues.raydium ? {
          mintAddress: this.queues.raydium.mintAddress,
          source: this.queues.raydium.source,
        } : null,
      },
    };
  }
}

export const coinQueue = new CoinProcessingQueue();
