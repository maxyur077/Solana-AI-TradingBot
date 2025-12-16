import { sleep } from "./helpers.js";

class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async waitForSlot() {
    const now = Date.now();
    this.requests = this.requests.filter((timestamp) => now - timestamp < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      if (waitTime > 0) {
        await sleep(waitTime);
      }
      return this.waitForSlot();
    }

    this.requests.push(now);
  }

  async execute(fn) {
    await this.waitForSlot();
    return fn();
  }
}

class APIRateLimiter {
  constructor() {
    this.limiters = new Map();
  }

  getLimiter(key, maxRequests, windowMs) {
    if (!this.limiters.has(key)) {
      this.limiters.set(key, new RateLimiter(maxRequests, windowMs));
    }
    return this.limiters.get(key);
  }

  async executeWithLimit(key, fn, maxRequests = 10, windowMs = 1000) {
    const limiter = this.getLimiter(key, maxRequests, windowMs);
    return limiter.execute(fn);
  }
}

export const globalRateLimiter = new APIRateLimiter();

export const DEX_RATE_LIMITS = {
  RAYDIUM: { maxRequests: 5, windowMs: 1000 },
  METEORA: { maxRequests: 5, windowMs: 1000 },
  PUMPFUN: { maxRequests: 3, windowMs: 1000 },
  JUPITER: { maxRequests: 10, windowMs: 1000 },
  HELIUS: { maxRequests: 8, windowMs: 1000 },
  RUGCHECK: { maxRequests: 2, windowMs: 1000 },
  RPC: { maxRequests: 5, windowMs: 1000 },
};

export async function executeWithDexRateLimit(dexName, fn) {
  const limits = DEX_RATE_LIMITS[dexName.toUpperCase()] || DEX_RATE_LIMITS.RPC;
  return globalRateLimiter.executeWithLimit(
    dexName,
    fn,
    limits.maxRequests,
    limits.windowMs
  );
}

export class RequestQueue {
  constructor(delayMs = 100) {
    this.queue = [];
    this.processing = false;
    this.delayMs = delayMs;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
      if (this.queue.length > 0) {
        await sleep(this.delayMs);
      }
    }

    this.processing = false;
  }
}

export const rpcQueue = new RequestQueue(100);
export const heliusQueue = new RequestQueue(150);
export const rugcheckQueue = new RequestQueue(500);
export const jupiterQueue = new RequestQueue(50);
