import ReconnectingWebSocket from "reconnecting-websocket";
import WebSocket from "ws";
import { EventEmitter } from "events";
import { logEvent } from "./databaseService.js";

const PUMP_FUN_WSS =
  "wss://pumpportal.fun/socket.io/?EIO=4&transport=websocket";

class PumpFunEmitter extends EventEmitter {}
export const pumpFunEmitter = new PumpFunEmitter();

export function monitorPumpFun() {
  logEvent("INFO", "Starting Pump.fun websocket monitoring...");
  const ws = new ReconnectingWebSocket(PUMP_FUN_WSS, [], { WebSocket });

  ws.addEventListener("open", () => {
    logEvent("SUCCESS", "Connected to Pump.fun websocket.");
    ws.send('42["subscribe",{"subscription":"new-token"}]');
  });

  ws.addEventListener("message", (event) => {
    try {
      const message = event.data.toString();

      if (message === "3") {
        ws.send("2"); // Send a pong '2' back
        return;
      }

      if (message.startsWith("42")) {
        const data = JSON.parse(message.substring(2));
        const eventType = data[0];
        const eventData = data[1];

        if (eventType === "new-token" && eventData.mint) {
          logEvent(
            "SUCCESS",
            `New pump.fun token detected: ${eventData.symbol}`,
            eventData
          );
          pumpFunEmitter.emit("newToken", {
            mint: eventData.mint,
            name: eventData.name,
            symbol: eventData.symbol,
            description: eventData.description,
            image: eventData.image_uri,
            creator: eventData.creator,
            source: "pump.fun",
          });
        }
      }
    } catch (error) {
      logEvent("WARN", "Failed to parse Pump.fun websocket message.", {
        error: error.message,
        data: event.data,
      });
    }
  });

  ws.addEventListener("error", (error) => {
    logEvent("ERROR", "Pump.fun websocket error.", { error: error.message });
  });

  ws.addEventListener("close", () => {
    logEvent("WARN", "Disconnected from Pump.fun websocket. Reconnecting...");
  });
}
