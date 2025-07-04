import fs from "fs/promises";
import { logEvent } from "./databaseService.js";

const blacklist = new Set();

export async function loadBlacklist() {
  try {
    const data = await fs.readFile("blacklist.txt", "utf8");
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim()) {
        blacklist.add(line.trim().toLowerCase());
      }
    }
    await logEvent(
      "SUCCESS",
      `Loaded ${blacklist.size} terms into the blacklist.`
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      await logEvent("WARN", "blacklist.txt not found. Creating it.");
      await fs.writeFile("blacklist.txt", "", "utf8");
    } else {
      await logEvent("ERROR", "Failed to load blacklist.txt", { error });
    }
  }
}

export async function addToBlacklist(name, symbol) {
  const lowerName = (name || "").toLowerCase().trim();
  const lowerSymbol = (symbol || "").toLowerCase().trim();

  try {
    if (lowerName && !blacklist.has(lowerName)) {
      await fs.appendFile("blacklist.txt", `\n${lowerName}`);
      blacklist.add(lowerName);
      await logEvent("INFO", `Added '${name}' to blacklist.`);
    }
    if (lowerSymbol && !blacklist.has(lowerSymbol)) {
      await fs.appendFile("blacklist.txt", `\n${lowerSymbol}`);
      blacklist.add(lowerSymbol);
      await logEvent("INFO", `Added '${symbol}' to blacklist.`);
    }
  } catch (error) {
    await logEvent("ERROR", "Failed to write to blacklist.txt", { error });
  }
}

export function isBlacklisted(name, symbol) {
  const lowerName = (name || "").toLowerCase();
  const lowerSymbol = (symbol || "").toLowerCase();

  for (const term of blacklist) {
    if (lowerName.includes(term) || lowerSymbol.includes(term)) {
      return true;
    }
  }
  return false;
}
