import { FILTERED_TOKEN_NAMES, FILTERED_TOKEN_SYMBOLS, SOL_MINT, COMMON_TOKENS, SYSTEM_PROGRAMS, METEORA_PROGRAMS } from "./constants.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function shouldFilterMeteoraToken(name, symbol) {
  const nameLower = (name || "").toLowerCase();
  const symbolUpper = (symbol || "").toUpperCase();

  for (const filtered of FILTERED_TOKEN_NAMES) {
    if (nameLower.includes(filtered)) {
      return true;
    }
  }

  if (FILTERED_TOKEN_SYMBOLS.includes(symbolUpper)) {
    return true;
  }

  return false;
}

export function isValidMintAddress(address) {
  return address && address.length >= 32 && address.length <= 44;
}

export function isExcludedAddress(address) {
  return (
    address === SOL_MINT ||
    COMMON_TOKENS.includes(address) ||
    SYSTEM_PROGRAMS.includes(address) ||
    Object.values(METEORA_PROGRAMS).includes(address)
  );
}

export function formatSol(lamports) {
  return lamports / 1e9;
}

export function toLamports(sol) {
  return Math.round(sol * 1e9);
}

export function calculatePnlPercentage(currentPrice, purchasePrice) {
  if (purchasePrice === 0) return 0;
  return ((currentPrice - purchasePrice) / purchasePrice) * 100;
}

export function calculateDropFromPeak(highestPrice, currentPrice) {
  if (highestPrice === 0) return 0;
  return ((highestPrice - currentPrice) / highestPrice) * 100;
}

export function truncateAddress(address, length = 8) {
  if (!address) return "";
  return `${address.slice(0, length)}...`;
}

export function getRpcName(url) {
  if (url.includes("helius")) return "Helius";
  if (url.includes("quicknode")) return "QuickNode";
  if (url.includes("mainnet-beta")) return "Public";
  return "Custom";
}

export function getTrailingPercentForRisk(riskLevel, basePercent) {
  switch (riskLevel) {
    case "DANGER":
      return Math.max(basePercent - 2, 3);
    case "WARNING":
      return Math.max(basePercent - 1, 4);
    case "GOOD":
    default:
      return basePercent;
  }
}

export function createWsEndpoint(httpUrl) {
  return httpUrl.replace("https://", "wss://").replace("http://", "ws://");
}
