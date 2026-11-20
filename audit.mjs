#!/usr/bin/env node
/**
 * Automated server audit for THE SOCIETY HUB.
 *
 * Scans the whole server for:
 *  - unethical / toxic / NSFW / scam content in messages
 *  - dangerous permissions on roles
 *  - risky configuration (open invites, webhooks, NSFW channels, missing AutoMod)
 * and posts a compact report to the alert channel (#bot-logs).
 *
 * Run manually:  node audit.mjs
 * Automated:     scheduled daily (see README)
 *
 * Exit codes: 0 = clean, 1 = audit could not run, 2 = issues found.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader -------------------------------------------------------
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch { /* env may come from the shell */ }
}
loadEnv();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ALERT_CHANNEL_ID = process.env.ALERT_CHANNEL_ID;
if (!TOKEN || !GUILD_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or GUILD_ID (set them in .env).");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
const H = { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" };

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  let data;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 300);
    }
  }
  if (!res.ok) {
    const err = new Error(
      `Discord ${res.status} ${path}: ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 200)}`
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Fetch a resource the bot may not be allowed to read; record why when skipped. */
async function optional(report, label, path) {
  try {
    return await api("GET", path);
  } catch (err) {
    report.notes.push(`${label} unavailable (${err.status ?? "error"})`);
    return undefined;
  }
}

// --- heuristic content analysis --------------------------------------------
const TOXIC = [
  "fuck", "shit", "bitch", "bastard", "asshole", "dick", "cunt", "whore",
  "slut", "retard", "faggot", "nigg", "kys", "kill yourself",
  "rape", "molest", "pedo", "nazi", "hitler",
];
const SCAM = [
  "free nitro", "nitro giveaway", "steam gift", "free robux", "crypto giveaway",
  "double your", "click here to claim", "airdrop", "wallet connect",
  "verify your account", "claim your prize", "you won",
];
const NSFW_LINKS = [
  "porn", "xxx", "onlyfans", "nudes", "hentai", "rule34", "e621",
];
const INVITE_RE = /(discord\.gg|discord(app)?\.com\/invite)\/[A-Za-z0-9-]+/i;
const URL_RE = /https?:\/\/[^\s]+/gi;

const DANGEROUS_ROLE_PERMS = [
  [1n << 3n, "Administrator"],
  [1n << 5n, "ManageGuild"],
  [1n << 28n, "ManageRoles"],
  [1n << 4n, "ManageChannels"],
  [1n << 2n, "BanMembers"],
  [1n << 29n, "ManageWebhooks"],
];

function analyzeMessage(m) {
  const content = m.content || "";
  const text = content.toLowerCase();
  const flags = [];
  for (const w of TOXIC) if (text.includes(w)) flags.push(`toxic:"${w}"`);
  for (const w of SCAM) if (text.includes(w)) flags.push(`scam:"${w}"`);
  for (const w of NSFW_LINKS) if (text.includes(w)) flags.push(`nsfw:"${w}"`);
  if (INVITE_RE.test(content)) flags.push("invite-link");
  if ((m.mentions?.length ?? 0) >= 5) flags.push(`mass-mention:${m.mentions.length}`);
  if (content.length > 400 && (content.match(/[A-Z]/g) || []).length > 250) flags.push("excessive-caps");
  const urls = content.match(URL_RE) || [];
  if (urls.length >= 4) flags.push(`link-spam:${urls.length}`);
  return flags;
}

// --- audit ------------------------------------------------------------------
const report = { generated: new Date().toISOString(), issues: [], warnings: [], notes: [], info: {} };

let guild;
let channels;
let roles;
try {
  [guild, channels, roles] = await Promise.all([
    api("GET", `/guilds/${GUILD_ID}?with_counts=true`),
    api("GET", `/guilds/${GUILD_ID}/channels`),
    api("GET", `/guilds/${GUILD_ID}/roles`),
  ]);
} catch (err) {
  console.error("Audit could not read the guild:", err.message);
  process.exit(1);
}

const [members, webhooks, invites, bans, automod] = await Promise.all([
  optional(report, "member list", `/guilds/${GUILD_ID}/members?limit=1000`),
  optional(report, "webhook list", `/guilds/${GUILD_ID}/webhooks`),
  optional(report, "invite list", `/guilds/${GUILD_ID}/invites`),
  optional(report, "ban list", `/guilds/${GUILD_ID}/bans`),
  optional(report, "AutoMod rules", `/guilds/${GUILD_ID}/auto-moderation/rules`),
]);

report.info = {
  server: guild.name,
  members: guild.approximate_member_count ?? members?.length ?? 0,
  bots: (members ?? []).filter((m) => m.user?.bot).length,
  channels: channels.length,
  roles: roles.length,
  bans: bans?.length ?? 0,
  invites: invites?.length ?? 0,
  webhooks: webhooks?.length ?? 0,
  automodRules: (automod ?? []).map((r) => r.name),
};

// 1. Role permission audit (Owner/Admin/Moderator are intentionally privileged)
const STAFF_ROLES = new Set(["Owner", "Admin", "Moderator"]);
for (const r of roles) {
  if (r.name === "@everyone" || r.managed || STAFF_ROLES.has(r.name)) continue;
  const perms = BigInt(r.permissions);
  const found = DANGEROUS_ROLE_PERMS.filter(([bit]) => (perms & bit) !== 0n).map(([, n]) => n);
  if (!found.length) continue;
  if (found.includes("Administrator")) report.warnings.push(`Role "${r.name}" has Administrator`);
  else report.warnings.push(`Role "${r.name}" has ${found.join(", ")}`);
}

// 2. Channel audit
for (const c of channels) {
  if (c.nsfw) report.warnings.push(`Channel #${c.name} is marked NSFW`);
}

// 3. Message content scan (last 100 per message channel)
let scanned = 0;
let flagged = 0;
let skippedChannels = 0;
for (const c of channels.filter((x) => x.type === 0 || x.type === 5)) {
  let messages;
  try {
    messages = await api("GET", `/channels/${c.id}/messages?limit=100`);
  } catch (err) {
    // One unreadable channel must not abort the whole audit.
    skippedChannels += 1;
    report.notes.push(`#${c.name} not scanned (${err.status ?? "error"})`);
    continue;
  }
  for (const m of messages) {
    scanned += 1;
    const flags = analyzeMessage(m);
    if (!flags.length) continue;
    flagged += 1;
    report.issues.push({
      channel: c.name,
      author: m.author?.username ?? "unknown",
      messageId: m.id,
      time: m.timestamp,
      flags,
      preview: (m.content || "").slice(0, 80).replace(/\n/g, " "),
    });
  }
}
if (skippedChannels) report.warnings.push(`${skippedChannels} channel(s) could not be scanned`);

// 4. AutoMod coverage check
if (automod) {
  if (automod.length === 0) report.warnings.push("No AutoMod rules configured");
  if (!automod.some((r) => r.trigger_type === 4)) report.warnings.push("No keyword-preset AutoMod rule (profanity/slurs/NSFW)");
  if (!automod.some((r) => r.trigger_type === 5)) report.warnings.push("No mention-spam AutoMod rule");
  if (!automod.some((r) => r.trigger_type === 3)) report.warnings.push("No spam AutoMod rule");
}

// 5. Invite / webhook hygiene
if (invites && invites.length > 3) report.warnings.push(`${invites.length} active invites — review them`);
if (webhooks && webhooks.length > 0) report.warnings.push(`${webhooks.length} webhook(s) configured — verify owners`);

// --- format report ----------------------------------------------------------
const lines = [];
lines.push(`# 🛡️ Server Audit — ${new Date().toLocaleString()}`);
lines.push("");
lines.push(
  `**${report.info.server}** · ${report.info.members} members (${report.info.bots} bots) · ${report.info.channels} channels · ${report.info.roles} roles`
);
lines.push(`AutoMod: ${report.info.automodRules.length ? report.info.automodRules.join(", ") : "none"}`);
lines.push("");
lines.push(`**Messages scanned:** ${scanned} · **Flagged:** ${flagged}`);
if (report.issues.length) {
  lines.push("");
  lines.push("### 🚩 Flagged messages");
  for (const i of report.issues.slice(0, 15)) {
    lines.push(`• #${i.channel} · ${i.author} · ${i.flags.join(", ")} — "${i.preview}"`);
  }
  if (report.issues.length > 15) lines.push(`…and ${report.issues.length - 15} more`);
}
if (report.warnings.length) {
  lines.push("");
  lines.push("### ⚠️ Configuration warnings");
  for (const w of report.warnings) lines.push(`• ${w}`);
}
if (report.notes.length) {
  lines.push("");
  lines.push("### ℹ️ Not checked");
  for (const n of report.notes.slice(0, 10)) lines.push(`• ${n}`);
}
if (!report.issues.length && !report.warnings.length) {
  lines.push("");
  lines.push("✅ No unethical content or risky configuration detected.");
}

const text = lines.join("\n");
console.log(text);

// --- post to alert channel --------------------------------------------------
if (ALERT_CHANNEL_ID) {
  // Discord caps messages at 2000 chars — split on lines, never mid-line.
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.slice(0, 1990);
    if (current && current.length + piece.length + 1 > 1900) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + piece;
  }
  if (current.trim()) chunks.push(current);

  try {
    for (const chunk of chunks) {
      await api("POST", `/channels/${ALERT_CHANNEL_ID}/messages`, { content: chunk });
    }
    console.log(`\nReport posted to alert channel ${ALERT_CHANNEL_ID}.`);
  } catch (err) {
    console.error(`\nCould not post the report: ${err.message}`);
  }
}

// exit non-zero if issues were found (useful for schedulers)
process.exitCode = report.issues.length > 0 ? 2 : 0;
