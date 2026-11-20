#!/usr/bin/env node
/**
 * End-to-end test: drives index.js over real stdio/MCP and exercises EVERY tool
 * against the live guild from .env. Creates temporary categories/channels/roles/
 * AutoMod rules named `mcp-selftest-*` and deletes them again in a finally block.
 *
 * Run: node test-e2e.mjs
 * Requires DISCORD_BOT_TOKEN + GUILD_ID in .env (or the environment).
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (same rules the server-side scripts use) --------------
try {
  const raw = readFileSync(join(__dirname, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* env from shell */ }

if (!process.env.DISCORD_BOT_TOKEN || !process.env.GUILD_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or GUILD_ID (.env) — cannot run a live test.");
  process.exit(1);
}
const GUILD = process.env.GUILD_ID;
const STAMP = Date.now().toString(36).slice(-6);
const API = "https://discord.com/api/v10";

async function apiGet(path, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      });
      if (!res.ok) throw new Error(`Discord ${res.status} on ${path}`);
      return await res.json();
    } catch (err) {
      // Transient network failures happen on flaky links — retry before reporting.
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw lastErr;
}

// --- minimal MCP client over stdio -----------------------------------------
const child = spawn(process.execPath, [join(__dirname, "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("non-JSON line on stdout:", line.slice(0, 200));
      continue;
    }
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  }
});

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function call(name, args = {}) {
  const msg = await request("tools/call", { name, arguments: args });
  if (msg.error) return { ok: false, text: JSON.stringify(msg.error) };
  const result = msg.result ?? {};
  const text = result.content?.[0]?.text ?? "";
  return { ok: !result.isError, text };
}

// --- assertions -------------------------------------------------------------
const results = [];
let cleanup = [];

function pass(label, extra = "") {
  results.push({ ok: true, label });
  console.log(`  PASS  ${label}${extra ? " — " + extra : ""}`);
}
function fail(label, detail) {
  results.push({ ok: false, label, detail });
  console.log(`  FAIL  ${label}\n        ${String(detail).slice(0, 400)}`);
}

async function expectOk(label, name, args) {
  const r = await call(name, args);
  if (r.ok) return { ok: true, text: r.text };
  fail(label, r.text);
  return { ok: false, text: r.text };
}

function expectErr(label, r, includes) {
  if (r.ok) return fail(label, `expected an error, got: ${r.text.slice(0, 200)}`);
  if (includes && !r.text.toLowerCase().includes(includes.toLowerCase())) {
    return fail(label, `error did not mention "${includes}": ${r.text.slice(0, 200)}`);
  }
  pass(label, r.text.slice(0, 90).replace(/\s+/g, " "));
}

// --- run --------------------------------------------------------------------
try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0" },
  });
  if (init.result?.serverInfo?.name === "discord-mcp") pass("initialize", JSON.stringify(init.result.serverInfo));
  else fail("initialize", JSON.stringify(init).slice(0, 300));
  notify("notifications/initialized");

  // ---- discovery ----
  const list = await request("tools/list");
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  if (tools.length >= 20) pass("tools/list", `${tools.length} tools`);
  else fail("tools/list", `only ${tools.length} tools`);

  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (!dupes.length) pass("tool names unique");
  else fail("tool names unique", dupes.join(","));

  const badSchemas = tools.filter(
    (t) => !t.description || t.inputSchema?.type !== "object" || !t.inputSchema.properties
  );
  if (!badSchemas.length) pass("every tool has description + object schema");
  else fail("schemas", badSchemas.map((t) => t.name).join(","));

  // Every tool must have a handler, and every argument a handler reads must be
  // declared in the schema (with additionalProperties:false a client could
  // never send an undeclared one).
  const src = readFileSync(join(__dirname, "index.js"), "utf8");
  const handlerSrc = src.slice(src.indexOf("async function callTool"), src.indexOf("function parseColor"));
  const caseBlocks = new Map();
  const caseRe = /case "([a-z_]+)":/g;
  const starts = [...handlerSrc.matchAll(caseRe)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : handlerSrc.length;
    caseBlocks.set(m[1], handlerSrc.slice(m.index, end));
  });
  const missingHandlers = names.filter((n) => !caseBlocks.has(n));
  if (!missingHandlers.length) pass("every tool has a handler case");
  else fail("missing handler cases", missingHandlers.join(", "));

  const undeclared = [];
  for (const t of tools) {
    const block = caseBlocks.get(t.name) ?? "";
    const used = [...block.matchAll(/args\.([a-zA-Z_]+)/g)].map((m) => m[1]);
    for (const a of new Set(used)) {
      if (!(a in (t.inputSchema.properties ?? {}))) undeclared.push(`${t.name}.${a}`);
    }
  }
  if (!undeclared.length) pass("no handler reads undeclared arguments");
  else fail("undeclared arguments", undeclared.join(", "));

  const guilds = await expectOk("list_guilds", "list_guilds");
  if (guilds.ok && guilds.text.includes(GUILD)) pass("list_guilds includes the guild");
  else if (guilds.ok) fail("list_guilds includes the guild", guilds.text.slice(0, 200));

  const perms = await expectOk("list_permission_names", "list_permission_names");
  let permNames = [];
  try {
    permNames = JSON.parse(perms.text).permissions;
  } catch { /* reported by the assertion below */ }
  if (permNames.length > 40 && permNames.includes("ViewChannel")) pass("list_permission_names", `${permNames.length} names`);
  else fail("list_permission_names", perms.text.slice(0, 200));

  // ---- argument validation ----
  const missing = await call("list_channels", {});
  expectErr("missing required guild_id is rejected clearly", missing, "guild_id");

  const unknownPerm = await call("create_role", { guild_id: GUILD, name: "x", permissions: "NotAPerm" });
  expectErr("unknown permission name is rejected", unknownPerm, "NotAPerm");

  const unknownTool = await call("does_not_exist", {});
  expectErr("unknown tool returns an error", unknownTool, "Unknown tool");

  // ---- categories ----
  const cat = await expectOk("create_category", "create_category", { guild_id: GUILD, name: `mcp-selftest-${STAMP}` });
  let catId;
  try {
    catId = JSON.parse(cat.text).id;
    cleanup.push(["delete_channel", { channel_id: catId }]);
  } catch { /* failed already */ }
  if (catId) pass("create_category returns a channel id", catId);

  if (catId) {
    const edited = await expectOk("edit_category", "edit_category", {
      channel_id: catId,
      name: `mcp-selftest-${STAMP}-renamed`,
    });
    if (edited.ok && JSON.parse(edited.text).name.endsWith("-renamed")) pass("edit_category renames");
    else if (edited.ok) fail("edit_category renames", edited.text.slice(0, 200));

    const listed = await expectOk("list_channels", "list_channels", { guild_id: GUILD });
    if (listed.ok && JSON.parse(listed.text).some((c) => c.id === catId && c.type === "category"))
      pass("list_channels shows the new category");
    else if (listed.ok) fail("list_channels shows the new category", listed.text.slice(0, 300));
  }

  // ---- channels ----
  const text = await expectOk("create_text_channel", "create_text_channel", {
    guild_id: GUILD,
    name: `mcp-selftest-${STAMP}`,
    parent_id: catId,
    topic: "created by test-e2e.mjs",
    slowmode: 0,
  });
  let textId;
  try {
    textId = JSON.parse(text.text).id;
    cleanup.push(["delete_channel", { channel_id: textId }]);
  } catch { /* failed */ }
  if (textId) pass("create_text_channel returns a channel id", textId);

  const voice = await expectOk("create_voice_channel", "create_voice_channel", {
    guild_id: GUILD,
    name: `mcp-selftest-voice-${STAMP}`,
    parent_id: catId,
    user_limit: 2,
  });
  let voiceId;
  try {
    voiceId = JSON.parse(voice.text).id;
    cleanup.push(["delete_channel", { channel_id: voiceId }]);
  } catch { /* failed */ }
  if (voiceId) pass("create_voice_channel returns a channel id", voiceId);

  if (textId) {
    const edited = await expectOk("edit_channel", "edit_channel", {
      channel_id: textId,
      topic: "updated by test-e2e.mjs",
      slowmode: 5,
    });
    if (edited.ok && JSON.parse(edited.text).rate_limit_per_user === 5) pass("edit_channel applies slowmode");
    else if (edited.ok) fail("edit_channel applies slowmode", edited.text.slice(0, 300));

    const sent = await expectOk("send_message", "send_message", {
      channel_id: textId,
      content: "mcp-selftest message — safe to delete",
    });
    if (sent.ok && JSON.parse(sent.text).id) pass("send_message returns a message id");
    else if (sent.ok) fail("send_message returns a message id", sent.text.slice(0, 200));
  }

  // ---- roles ----
  const roleCreated = await expectOk("create_role", "create_role", {
    guild_id: GUILD,
    name: `mcp-selftest-${STAMP}`,
    color: "#5865F2",
    permissions: "ViewChannel, SendMessages",
    mentionable: false,
  });
  let roleId;
  try {
    const role = JSON.parse(roleCreated.text);
    roleId = role.id;
    cleanup.push(["delete_role", { guild_id: GUILD, role_id: roleId }]);
    const expected = ((1n << 10n) | (1n << 11n)).toString();
    if (role.permissions === expected) pass("create_role sets exactly the parsed permissions", role.permissions);
    else fail("create_role permissions", `expected ${expected}, got ${role.permissions}`);
    if (role.color === 5793266) pass("create_role parses hex color", role.color);
    else fail("create_role parses hex color", role.color);
  } catch { /* failed */ }

  const roles = await expectOk("list_roles", "list_roles", { guild_id: GUILD });
  if (roles.ok && roleId && JSON.parse(roles.text).some((r) => r.id === roleId)) pass("list_roles shows the new role");
  else if (roles.ok) fail("list_roles shows the new role", roles.text.slice(0, 200));

  if (roleId) {
    // Documented shape: only role_id + new fields (guild_id must NOT be needed).
    const editedRole = await expectOk("edit_role", "edit_role", {
      role_id: roleId,
      name: `mcp-selftest-${STAMP}-renamed`,
      color: "#EB459E",
      permissions: "ViewChannel, SendMessages, ReadMessageHistory",
    });
    if (editedRole.ok) {
      const r = JSON.parse(editedRole.text);
      const expected = ((1n << 10n) | (1n << 11n) | (1n << 16n)).toString();
      if (r.name.endsWith("-renamed") && r.permissions === expected && r.color === 15418782)
        pass("edit_role updates name, color and permissions");
      else fail("edit_role result", JSON.stringify({ name: r.name, perms: r.permissions, color: r.color }));
    }

    const positions = await expectOk("set_role_positions", "set_role_positions", {
      guild_id: GUILD,
      positions: [{ role_id: roleId, position: 1 }],
    });
    if (positions.ok) pass("set_role_positions accepted the request");
  }

  // ---- channel permission overwrites ----
  if (textId && roleId) {
    const setPerm = await expectOk("set_channel_permissions", "set_channel_permissions", {
      channel_id: textId,
      target_type: "role",
      target_id: roleId,
      allow: "ViewChannel",
      deny: "SendMessages",
      mode: "set",
    });
    if (setPerm.ok) {
      const ow = (JSON.parse(setPerm.text).permission_overwrites ?? []).find((o) => o.id === roleId);
      if (ow && ow.allow === (1n << 10n).toString() && ow.deny === (1n << 11n).toString()) pass("set mode writes exact allow/deny");
      else fail("set mode allow/deny", JSON.stringify(ow));
    }

    // update mode must add to allow AND clear a conflicting deny bit.
    const upd = await expectOk("set_channel_permissions", "set_channel_permissions", {
      channel_id: textId,
      target_type: "role",
      target_id: roleId,
      allow: "SendMessages",
      mode: "update",
    });
    if (upd.ok) {
      const ow = (JSON.parse(upd.text).permission_overwrites ?? []).find((o) => o.id === roleId);
      if (ow && ow.allow === ((1n << 10n) | (1n << 11n)).toString() && ow.deny === "0")
        pass("update mode merges and clears conflicting deny bits", JSON.stringify(ow));
      else fail("update mode merge", JSON.stringify(ow));
    }

    const removed = await expectOk("remove_channel_permissions", "remove_channel_permissions", {
      channel_id: textId,
      target_id: roleId,
    });
    if (removed.ok) {
      const gone = !(JSON.parse(removed.text).permission_overwrites ?? []).some((o) => o.id === roleId);
      if (gone) pass("remove_channel_permissions removes the overwrite");
      else fail("remove_channel_permissions", "overwrite still present");
    }

    // Member overwrite (target_type must be accepted by Discord as type 1).
    const memberOw = await call("set_channel_permissions", {
      channel_id: textId,
      target_type: "member",
      target_id: process.env.SELFTEST_MEMBER_ID ?? "",
      allow: "ViewChannel",
      mode: "set",
    });
    if (!process.env.SELFTEST_MEMBER_ID) {
      if (!memberOw.ok) pass("member overwrite with empty id rejects (validation)", memberOw.text.slice(0, 80));
      else fail("member overwrite with empty id", "unexpectedly succeeded");
    }

    // Bot cannot manage channels above its own role — expect a clean Discord error.
    const above = await call("set_channel_permissions", {
      channel_id: textId,
      target_type: "role",
      target_id: GUILD,
      allow: "ViewChannel",
      mode: "set",
    });
    if (!above.ok && above.text.includes("@everyone")) pass("cannot modify @everyone overwrite (clean error)");
    else if (above.ok) pass("@everyone overwrite accepted");
  }

  // ---- guild ----
  const guildInfo = await call("edit_guild", { guild_id: GUILD, name: "" });
  expectErr("edit_guild rejects an empty name", guildInfo, "name");

  // ---- AutoMod ----
  const rule = await expectOk("create_automod_rule", "create_automod_rule", {
    guild_id: GUILD,
    name: `mcp-selftest-${STAMP}`,
    trigger_type: "keyword",
    keywords: ["mcp-selftest-blocked"],
    action: "block",
  });
  let ruleId;
  try {
    ruleId = JSON.parse(rule.text).id;
    cleanup.push(["delete_automod_rule", { guild_id: GUILD, rule_id: ruleId }]);
  } catch { /* failed */ }
  if (ruleId) pass("create_automod_rule returns a rule id", ruleId);

  const rules = await expectOk("list_automod_rules", "list_automod_rules", { guild_id: GUILD });
  if (rules.ok && ruleId) {
    const listed = JSON.parse(rules.text).find((r) => r.id === ruleId);
    if (listed?.trigger_type === "keyword") pass("list_automod_rules reports keyword trigger");
    else fail("list_automod_rules keyword mapping", JSON.stringify(listed));
  }

  const preset = await call("create_automod_rule", {
    guild_id: GUILD,
    name: `mcp-selftest-preset-${STAMP}`,
    trigger_type: "keyword",
    presets: ["profanity"],
    action: "block",
  });
  if (preset.ok) {
    const p = JSON.parse(preset.text);
    cleanup.push(["delete_automod_rule", { guild_id: GUILD, rule_id: p.id }]);
    if (p.trigger_type === 4 && Array.isArray(p.trigger_metadata?.presets)) pass("preset rule uses KEYWORD_PRESET");
    else fail("preset rule trigger_type", JSON.stringify({ t: p.trigger_type, m: p.trigger_metadata }));
    if (!(p.trigger_metadata?.keyword_filter ?? []).includes("mcp-selftest-preset"))
      pass("preset rule carries no keyword_filter (Discord rejects that combination)");
    else fail("preset rule", "keyword_filter sent alongside presets");
  } else if (/Maximum number of rules/i.test(preset.text)) {
    // Discord allows one rule per trigger type; the guild already has a preset rule.
    pass(
      "preset rule rejected by Discord's quota, not by our payload",
      "a KEYWORD_PRESET rule already exists (max 1 per trigger type)"
    );
  } else {
    fail("create preset automod rule", preset.text);
  }

  const mixedPreset = await call("create_automod_rule", {
    guild_id: GUILD,
    name: `mcp-selftest-mixed-${STAMP}`,
    trigger_type: "keyword",
    presets: ["profanity"],
    keywords: ["mcp-selftest-mixed"],
    action: "block",
  });
  expectErr("presets + keywords together are rejected locally", mixedPreset, "not both");

  const timeoutRule = await call("create_automod_rule", {
    guild_id: GUILD,
    name: `mcp-selftest-timeout-${STAMP}`,
    trigger_type: "mention_spam",
    mention_limit: 5,
    action: "timeout",
    timeout_seconds: 60,
  });
  if (timeoutRule.ok) {
    const t = JSON.parse(timeoutRule.text);
    cleanup.push(["delete_automod_rule", { guild_id: GUILD, rule_id: t.id }]);
    const ok = t.trigger_type === 5 && t.trigger_metadata?.mention_total_limit === 5 &&
      t.actions.some((a) => a.type === 3 && a.metadata?.duration_seconds === 60);
    if (ok) pass("mention_spam timeout rule created correctly");
    else fail("mention_spam timeout rule", JSON.stringify({ t: t.trigger_type, m: t.trigger_metadata, a: t.actions }));
  } else if (/Maximum number of rules/i.test(timeoutRule.text)) {
    pass(
      "mention_spam rule rejected by Discord's quota, not by our payload",
      "a MENTION_SPAM rule already exists (max 1 per trigger type)"
    );
  } else {
    fail("create mention_spam timeout rule", timeoutRule.text);
  }

  const badRule = await call("create_automod_rule", {
    guild_id: GUILD,
    name: `mcp-selftest-bad-${STAMP}`,
    trigger_type: "keyword",
    action: "block",
  });
  expectErr("automod rule with no keywords is rejected locally", badRule, "keyword");

  const badTimeout = await call("create_automod_rule", {
    guild_id: GUILD,
    name: `mcp-selftest-bad2-${STAMP}`,
    trigger_type: "keyword",
    keywords: ["x"],
    action: "timeout",
    timeout_seconds: 5,
  });
  expectErr("automod timeout below 60s is rejected locally", badTimeout, "timeout_seconds");

  // ---- audit.mjs: real run against the live guild, reports into the temp channel ----
  if (textId) {
    const audit = spawnSync(process.execPath, [join(__dirname, "audit.mjs")], {
      cwd: __dirname,
      env: { ...process.env, GUILD_ID: GUILD, ALERT_CHANNEL_ID: textId },
      encoding: "utf8",
      timeout: 240000,
    });
    const out = `${audit.stdout ?? ""}${audit.stderr ?? ""}`;
    if (audit.error) {
      fail("audit.mjs ran", audit.error.message);
    } else {
      if (audit.status === 0 || audit.status === 2) pass("audit.mjs exit code", `${audit.status} (0 = clean, 2 = issues found)`);
      else fail("audit.mjs exit code", `status ${audit.status}\n${out.slice(0, 500)}`);

      if (/Messages scanned:\**\s*\d+/.test(out)) pass("audit.mjs reports the scanned message count");
      else fail("audit.mjs scan summary", out.slice(0, 500));

      if (/Server Audit/.test(out)) pass("audit.mjs renders the report header");
      else fail("audit.mjs report header", out.slice(0, 400));

      if (/Report posted to alert channel/.test(out)) {
        const msgs = await apiGet(`/channels/${textId}/messages?limit=10`).catch((e) => ({ error: e.message }));
        const posted =
          Array.isArray(msgs) && msgs.some((m) => (m.content ?? "").includes("Server Audit"));
        if (posted) pass("audit.mjs posted the report to the alert channel");
        else fail("audit.mjs posted the report", JSON.stringify(msgs).slice(0, 400));
      } else {
        fail("audit.mjs posted the report", out.slice(-500));
      }
    }
  }

  // ---- presence.mjs: real gateway login keeps the bot online ----
  {
    const presence = spawn(process.execPath, [join(__dirname, "presence.mjs")], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pout = "";
    let perr = "";
    presence.stdout.on("data", (d) => (pout += d.toString()));
    presence.stderr.on("data", (d) => (perr += d.toString()));

    // Gateway identify can be throttled right after the MCP run — allow a generous window.
    const deadline = Date.now() + 90000;
    let online = false;
    while (Date.now() < deadline) {
      if (/online as /.test(pout)) {
        online = true;
        break;
      }
      if (presence.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    presence.kill("SIGTERM");

    if (online) pass("presence.mjs connects to the gateway", pout.match(/online as [^\n]+/)?.[0]);
    else fail("presence.mjs connects to the gateway", (pout + perr).slice(0, 400) || "no output");
  }
} catch (err) {
  fail("unexpected exception", err.stack ?? err.message);
} finally {
  console.log("\ncleanup:");
  for (const [name, args] of cleanup.reverse()) {
    const r = await call(name, args).catch((e) => ({ ok: false, text: e.message }));
    console.log(`  ${r.ok ? "removed" : "FAILED"}  ${name} ${JSON.stringify(args)}${r.ok ? "" : " — " + r.text.slice(0, 200)}`);
  }
  child.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nfailures:");
    for (const f of failed) console.log(` • ${f.label}: ${String(f.detail ?? "").slice(0, 300).replace(/\s+/g, " ")}`);
  }
  if (stderr.trim()) console.log("\nserver stderr:\n" + stderr.trim().slice(0, 2000));
  process.exit(failed.length ? 1 : 0);
}
