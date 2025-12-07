export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

export const METEORA_PROGRAMS = {
  DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  DAMM_V2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  DAMM_V1: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  DBC: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
};

export const POOL_INIT_INDICATORS = {
  RAYDIUM: ["initialize2", "Initialize2"],
  DLMM: ["initializeLbPair", "InitializeLbPair", "initialize_lb_pair"],
  DAMM_V2: ["initializePool", "InitializePool", "initialize_pool", "createPool", "CreatePool"],
  DAMM_V1: ["initialize", "Initialize"],
  DBC: ["initializeBondingCurve", "InitializeBondingCurve", "createPool"],
};

export const FILTERED_TOKEN_NAMES = [
  "meteora position nft",
  "meteora position",
  "position nft",
  "lp token",
  "liquidity token",
  "pool token",
];

export const FILTERED_TOKEN_SYMBOLS = ["MPN", "LP", "MET-LP"];

export const COMMON_TOKENS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
];

export const SYSTEM_PROGRAMS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
];

export const DEX_TYPES = {
  RAYDIUM: "raydium",
  METEORA: "meteora",
  METEORA_DAMM_V2: "meteora-damm_v2",
  METEORA_DLMM: "meteora-dlmm",
  JUPITER: "jupiter",
};

export const RISK_LEVELS = {
  GOOD: "GOOD",
  WARNING: "WARNING",
  DANGER: "DANGER",
  UNKNOWN: "UNKNOWN",
};

export const TRADE_STATUS = {
  BOUGHT: "BOUGHT",
  SOLD: "SOLD",
  SELL_FAILED: "SELL_FAILED",
};
