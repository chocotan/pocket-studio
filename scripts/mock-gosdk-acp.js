#!/usr/bin/env node

const readline = require("node:readline");

const SESSION_ID = "gosdk-e2e-session";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000001";
const chunks = ["FIRST|", "MIDDLE|", "FINAL"];

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
        },
      });
      break;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: SESSION_ID },
      });
      break;
    case "session/prompt":
      chunks.forEach((text, index) => {
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: MESSAGE_ID,
                content: { type: "text", text },
              },
            },
          });
          if (index === chunks.length - 1) {
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: { stopReason: "end_turn" },
            });
          }
        }, 150 * (index + 1));
      });
      break;
    case "session/close":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
  }
});
