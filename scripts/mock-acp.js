#!/usr/bin/env node

const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      // Respond to initialize
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "1",
          capabilities: {
            resume: true,
            load: true
          },
          models: {
            currentModelId: "mock-model",
            availableModels: [
              { id: "mock-model", name: "Mock Model" }
            ]
          }
        }
      }));
    } else if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") {
      // Respond to session creation
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "mock-session-id-123",
          models: {
            currentModelId: "mock-model",
            availableModels: [
              { id: "mock-model", name: "Mock Model" }
            ]
          }
        }
      }));
    } else if (msg.method === "session/prompt") {
      // Send message chunk updates (the thinking/reply content)
      setTimeout(() => {
        // Send a message chunk
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "mock-session-id-123",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Hello! This is a mock response from the Direct ACP agent. I have successfully analyzed the project structure."
              }
            }
          }
        }));

        // Send turn completion
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            stopReason: "end_turn"
          }
        }));
      }, 500);
    }
  } catch (err) {
    console.error("Mock ACP Error:", err);
  }
});
