#!/usr/bin/env node
/**
 * Keeps the bot online with a live gateway connection + presence.
 *
 * The MCP server is REST-only, so Discord shows the bot as offline.
 * This process holds the WebSocket gateway open, making the bot appear online.
 *
 * Run:      node presence.mjs
 * Auto-run: Windows task "SocietyHub-RavenPresence" at logon
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits, ActivityType } from "discord.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const raw = readFileSync(join(__dirname, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
} catch { /* env from shell */ }

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN missing (.env)");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

let attempt = 0;
let stopping = false;

client.once("clientReady", (c) => {
  attempt = 0;
  log(`online as ${c.user.tag} (${c.user.id})`);
  // setPresence is synchronous (returns undefined) in discord.js 14.28 — it is not a
  // promise, so it must not be chained with .catch(). Handle both shapes defensively.
  try {
    const pending = c.user.setPresence({
      status: "online",
      activities: [{ name: "over the server", type: ActivityType.Watching }],
    });
    if (pending && typeof pending.catch === "function") {
      pending.catch((err) => log("presence update failed:", err.message));
    }
  } catch (err) {
    log("presence update failed:", err?.message ?? err);
  }
});

client.on("error", (e) => console.error(`[${new Date().toISOString()}] client error:`, e.message));
client.on("shardError", (e) => console.error(`[${new Date().toISOString()}] shard error:`, e.message));
client.on("shardDisconnect", () => log("gateway disconnected — reconnecting…"));
client.on("shardReconnecting", () => log("reconnecting to the gateway…"));
client.on("shardResume", (_, replayed) => log(`gateway resumed (${replayed ?? 0} events replayed)`));
client.on("invalidated", () => {
  console.error("session invalidated (token reset or revoked) — exiting so the supervisor can restart");
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err instanceof Error ? err.message : err);
});

/**
 * Log in, retrying with exponential backoff. Without this a transient DNS or
 * network failure crashed the process and the bot stayed offline until logon.
 */
async function connect() {
  if (stopping) return;
  try {
    await client.login(TOKEN);
  } catch (err) {
    attempt += 1;
    const waitMs = Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000);
    console.error(
      `[${new Date().toISOString()}] login failed (${err.message}) — retry #${attempt} in ${Math.round(
        waitMs / 1000
      )}s`
    );
    setTimeout(connect, waitMs);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received — shutting down`);
  try {
    await client.destroy();
  } catch { /* already gone */ }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await connect();
