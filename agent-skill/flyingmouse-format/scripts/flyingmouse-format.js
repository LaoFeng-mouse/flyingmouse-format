#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const skillRoot = path.join(__dirname, "..");
const configPath = path.join(skillRoot, "launcher.json");

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, errorCode: "FLYINGMOUSE_LAUNCH_FAILED" })}\n`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  fail("FlyingMouse Format is not connected. Open the app and choose Connect to Agent.");
}

if (!path.isAbsolute(config.executable) || !fs.existsSync(config.executable)) {
  fail("The configured FlyingMouse Format executable no longer exists. Reconnect it from the app.");
}

const result = spawnSync(config.executable, [...(config.args || []), "--cli", ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true
});
if (result.error) fail(result.error.message);
process.exit(result.status == null ? 1 : result.status);
