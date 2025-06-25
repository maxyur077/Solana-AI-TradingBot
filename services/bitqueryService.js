import ReconnectingWebSocket from "reconnecting-websocket";
import WebSocket from "ws";
import { EventEmitter } from "events";
import { logEvent } from "./databaseService.js";
import { BITQUERY_API_KEY } from "../config.js";

class BitQueryEmitter extends EventEmitter {}
export const bitqueryEmitter = new BitQueryEmitter();

const BITQUERY_WSS = `wss://streaming.bitquery.io/eap?token=${BITQUERY_API_KEY}`;
const GQL_SUBSCRIPTION = `
  subscription {
    Solana {
      Instructions(
        where: {
          Instruction: { Program: { Method: { is: "initializeMint2" } } }
        }
        orderBy: { descending: Block_Time }
      ) {
        Instruction {
          Accounts {
            Address
          }
        }
      }
    }
  }
`;

export function monitorBitQuery() {
  logEvent("INFO", "Starting BitQuery websocket monitoring...");
  const ws = new ReconnectingWebSocket(BITQUERY_WSS, ["graphql-ws"], {
    WebSocket,
    connectionTimeout: 5000,
    maxRetries: Infinity,
  });

  ws.addEventListener("open", () => {
    logEvent("SUCCESS", "Connected to BitQuery websocket.");
    ws.send(
      JSON.stringify({
        type: "connection_init",
        payload: {},
      })
    );
  });

  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data.toString());

      if (message.type === "connection_ack") {
        logEvent("INFO", "Connection acknowledged by BitQuery server.");
        ws.send(
          JSON.stringify({
            id: "1",
            type: "start",
            payload: { query: GQL_SUBSCRIPTION },
          })
        );
        logEvent("INFO", "Subscription message sent.");
      } else if (message.type === "data" && message.payload?.data) {
        const instructions = message.payload.data.Solana.Instructions;
        if (instructions && instructions.length > 0) {
          const mint = instructions[0].Instruction.Accounts[0].Address;
          if (mint) {
            bitqueryEmitter.emit("newToken", { mint, source: "BitQuery" });
          }
        }
      } else if (message.type === "error") {
        logEvent("ERROR", "BitQuery websocket error.", {
          error: message.payload,
        });
      }
    } catch (error) {
      logEvent("WARN", "Failed to parse BitQuery websocket message.", {
        error: error.message,
        data: event.data,
      });
    }
  });

  ws.addEventListener("error", (error) => {
    logEvent("ERROR", "BitQuery websocket connection error.", {
      error: error.message,
    });
  });

  ws.addEventListener("close", (event) => {
    logEvent("WARN", "Disconnected from BitQuery websocket. Reconnecting...", {
      code: event.code,
      reason: event.reason,
    });
  });
}
