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
      await logEvent(
        "WARN",
        "blacklist.txt not found. Starting with an empty blacklist."
      );
    } else {
      await logEvent("ERROR", "Failed to load blacklist.txt", { error });
    }
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
