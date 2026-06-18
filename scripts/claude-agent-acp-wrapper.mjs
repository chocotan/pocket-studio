#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const settingsPath = join(homedir(), ".claude", "settings.json");
if (existsSync(settingsPath)) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const [key, value] of Object.entries(settings.env || {})) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_")) {
      process.env[key] = String(value);
    }
  }
}

const child = spawn("npx", ["-y", "@agentclientprotocol/claude-agent-acp@^0.37.0", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
