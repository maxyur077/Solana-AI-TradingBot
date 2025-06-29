import axios from "axios";
import { logEvent } from "./databaseService.js";
import {
  RPC_URL,
  MAX_HOLDER_CONCENTRATION_PERCENT,
  MIN_LIQUIDITY_USD,
} from "../config.js";
import fetch from "cross-fetch";

export async function getTokenMetadata(mintAddress) {
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "helius-test",
        method: "getAsset",
        params: { id: mintAddress },
      }),
    });
    const { result } = await response.json();
    if (result && result.content && result.content.metadata) {
      return {
        name: result.content.metadata.name,
        symbol: result.content.metadata.symbol,
      };
    }
    await logEvent("WARN", `Could not find metadata for mint: ${mintAddress}`);
    return null;
  } catch (error) {
    await logEvent(
      "ERROR",
      `Error fetching token metadata for ${mintAddress}`,
      { error }
    );
    return null;
  }
}

export async function checkRug(mintAddress) {
  await logEvent("INFO", `Checking full report for token: ${mintAddress}`);
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`;
    const response = await axios.get(url);

    if (response.data) {
      const report = response.data;

      // Critical Vetting Rules
      if (report.markets?.[0]?.lp?.lpLockedPct < 100) {
        await logEvent("WARN", `Vetting failed: LP not 100% locked.`, {
          mint: mintAddress,
          lockedPct: report.markets?.[0]?.lp?.lpLockedPct || 0,
        });
        return null;
      }
      if (report.tokenMeta?.mutable === true) {
        await logEvent("WARN", `Vetting failed: Metadata is mutable.`, {
          mint: mintAddress,
        });
        return null;
      }
      if (report.token?.freezeAuthority) {
        await logEvent("WARN", `Vetting failed: Token is freezable.`, {
          mint: mintAddress,
        });
        return null;
      }
      if (report.token?.mintAuthority) {
        await logEvent("WARN", `Vetting failed: Token is mintable.`, {
          mint: mintAddress,
        });
        return null;
      }

      const top10Percentage = (report.topHolders || [])
        .slice(0, 10)
        .reduce((sum, h) => sum + h.pct, 0);
      if (top10Percentage > MAX_HOLDER_CONCENTRATION_PERCENT) {
        await logEvent(
          "WARN",
          `Vetting failed: Top 10 holders own > ${MAX_HOLDER_CONCENTRATION_PERCENT}%.`,
          { mint: mintAddress, concentration: `${top10Percentage.toFixed(2)}%` }
        );
        return null;
      }
      if (
        !report.fileMeta?.website &&
        !report.fileMeta?.twitter &&
        !report.fileMeta?.telegram
      ) {
        await logEvent("WARN", `Vetting failed: No social links found.`, {
          mint: mintAddress,
        });
        return null;
      }

      let overallRiskLevel = "DANGER"; // Default to DANGER for safety
      if (report.risks && report.risks.length > 0) {
        const riskLevels = report.risks.map((r) => r.level.toUpperCase());
        if (riskLevels.includes("DANGER")) {
          overallRiskLevel = "DANGER";
        } else if (riskLevels.includes("WARN")) {
          overallRiskLevel = "WARNING";
        } else {
          overallRiskLevel = "GOOD";
        }
      }

      const summaryForPrompt = {
        score: report.score_normalised,
        risks: report.risks || [],
        risk: { level: overallRiskLevel },
      };

      await logEvent(
        "SUCCESS",
        `RugCheck report received and passed all checks.`,
        { mint: mintAddress, risk: summaryForPrompt.risk.level }
      );
      return summaryForPrompt;
    }
    return null;
  } catch (error) {
    await logEvent("ERROR", `Error calling RugCheck API`, {
      mint: mintAddress,
      error: error.message,
    });
    return null;
  }
}
