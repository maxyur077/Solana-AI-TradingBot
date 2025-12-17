import { logEvent } from "./databaseService.js";
import { getPortfolioSize } from "./tradeService.js";
import { MAX_PORTFOLIO_SIZE } from "../config.js";
import { pauseMeteora, resumeMeteora, pauseRaydium, resumeRaydium, pausePumpfun, resumePumpfun } from "./dexManager.js";

class CoinProcessingQueue {
  constructor() {
    this.queues = {
      pumpfun: null,
      meteora: null,
      raydium: null,
    };
    this.processing = {
      pumpfun: false,
      meteora: false,
      raydium: false,
    };
  }

  async add(signature, mintAddress, transaction, source, poolAddress, processor) {
    const currentPortfolioSize = getPortfolioSize();

    if (currentPortfolioSize >= MAX_PORTFOLIO_SIZE) {
      return;
    }

    const dexType = this.getDexType(source);

    const queueItem = {
      signature,
      mintAddress,
      transaction,
      source,
      poolAddress,
      processor,
      addedAt: Date.now(),
    };

    if (this.queues[dexType] !== null) {
      await logEvent("INFO", `Replacing ${dexType.toUpperCase()} queued coin with fresh coin`, {
        oldMint: this.queues[dexType].mintAddress,
        newMint: mintAddress,
        dexType,
      });
    }

    this.queues[dexType] = queueItem;

    await logEvent("INFO", `Added fresh coin to ${dexType.toUpperCase()} queue (parallel processing)`, {
      source,
      mintAddress,
      dexType,
      portfolioSize: currentPortfolioSize,
    });

    this.processDex(dexType);
  }

  async processDex(dexType) {
    if (this.processing[dexType]) {
      return;
    }

    this.processing[dexType] = true;

    const pauseFunctions = {
      pumpfun: pausePumpfun,
      meteora: null,
      raydium: pauseRaydium,
    };

    const resumeFunctions = {
      pumpfun: resumePumpfun,
      meteora: null,
      raydium: resumeRaydium,
    };

    try {
      while (this.queues[dexType] !== null) {
        const currentPortfolioSize = getPortfolioSize();

        if (currentPortfolioSize >= MAX_PORTFOLIO_SIZE) {
          await logEvent("INFO", `Portfolio full, clearing ${dexType.toUpperCase()} queue`, {
            portfolioSize: currentPortfolioSize,
          });
          this.queues[dexType] = null;
          break;
        }

        const item = this.queues[dexType];
        this.queues[dexType] = null;

        if (pauseFunctions[dexType]) {
          await pauseFunctions[dexType]();
        }

        await logEvent("INFO", `Processing ${dexType.toUpperCase()} coin in parallel`, {
          source: item.source,
          mintAddress: item.mintAddress,
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

          await logEvent("SUCCESS", `Completed ${dexType.toUpperCase()} coin processing`, {
            source: item.source,
            mintAddress: item.mintAddress,
          });
        } catch (error) {
          await logEvent("ERROR", `Error processing ${dexType.toUpperCase()} coin`, {
            source: item.source,
            mintAddress: item.mintAddress,
            error: error.message,
          });
        }

        if (resumeFunctions[dexType]) {
          await resumeFunctions[dexType]();
        }
      }
    } finally {
      this.processing[dexType] = false;
      await logEvent("INFO", `${dexType.toUpperCase()} processing thread finished`);
    }
  }

  getDexType(source) {
    const sourceLower = source.toLowerCase();
    if (sourceLower.includes("pumpfun")) return "pumpfun";
    if (sourceLower.includes("meteora")) return "meteora";
    if (sourceLower.includes("raydium")) return "raydium";
    return "meteora";
  }

  clearAllQueues() {
    this.queues = {
      pumpfun: null,
      meteora: null,
      raydium: null,
    };
  }

  getTotalQueuedCoins() {
    return Object.values(this.queues).filter(queue => queue !== null).length;
  }

  getQueueStatus() {
    return {
      totalQueued: this.getTotalQueuedCoins(),
      processing: this.processing,
      queues: {
        pumpfun: this.queues.pumpfun ? {
          mintAddress: this.queues.pumpfun.mintAddress,
          source: this.queues.pumpfun.source,
          addedAt: this.queues.pumpfun.addedAt,
        } : null,
        meteora: this.queues.meteora ? {
          mintAddress: this.queues.meteora.mintAddress,
          source: this.queues.meteora.source,
          addedAt: this.queues.meteora.addedAt,
        } : null,
        raydium: this.queues.raydium ? {
          mintAddress: this.queues.raydium.mintAddress,
          source: this.queues.raydium.source,
          addedAt: this.queues.raydium.addedAt,
        } : null,
      },
    };
  }
}

export const coinQueue = new CoinProcessingQueue();
