// Smoke test: spawn the MCP server over stdio, initialize, list tools and check
// local validation. Runs offline with a dummy token — no Discord calls.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["index.js"], {
  env: { ...process.env, DISCORD_BOT_TOKEN: "dummy-for-smoke-test" },
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
      console.error("non-JSON output:", line.slice(0, 200));
      continue;
    }
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      entry(msg);
    }
  }
});

function request(method, params, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function call(name, args = {}) {
  const msg = await request("tools/call", { name, arguments: args });
  if (msg.error) return { ok: false, text: JSON.stringify(msg.error) };
  return { ok: !msg.result?.isError, text: msg.result?.content?.[0]?.text ?? "" };
}

const failures = [];
function check(label, condition, detail = "") {
  if (condition) console.log(`PASS  ${label}`);
  else {
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0" },
  });
  check("initialize returns serverInfo", init.result?.serverInfo?.name === "discord-mcp", JSON.stringify(init.result?.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await request("tools/list");
  const tools = listed.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check("tools/list returns 22 tools", tools.length === 22, `${tools.length}`);
  check(
    "core tools present",
    ["list_guilds", "create_text_channel", "create_role", "set_channel_permissions", "send_message"].every((n) =>
      names.includes(n)
    )
  );
  check(
    "every tool documents an object schema",
    tools.every((t) => t.description && t.inputSchema?.type === "object")
  );

  const perms = await call("list_permission_names");
  const parsed = perms.ok ? JSON.parse(perms.text).permissions : [];
  check("list_permission_names returns permissions", parsed.includes("ViewChannel") && parsed.length > 40);

  const missing = await call("list_channels", {});
  check("missing guild_id is rejected locally", !missing.ok && missing.text.includes("guild_id"), missing.text.slice(0, 120));

  const badId = await call("list_channels", { guild_id: "not-an-id" });
  check("non-numeric guild_id is rejected locally", !badId.ok && badId.text.includes("Discord ID"), badId.text.slice(0, 120));

  const badPerm = await call("create_role", {
    guild_id: "1570497705598394508",
    name: "test",
    permissions: "NotAPerm",
  });
  check("unknown permission name is rejected", !badPerm.ok && badPerm.text.includes("NotAPerm"), badPerm.text.slice(0, 120));

  const badColor = await call("create_role", {
    guild_id: "1570497705598394508",
    name: "test",
    color: "banana",
  });
  check("invalid color is rejected", !badColor.ok && badColor.text.includes("Invalid color"), badColor.text.slice(0, 120));

  const unknown = await call("nope", {});
  check("unknown tool returns an error", !unknown.ok && unknown.text.includes("Unknown tool"), unknown.text.slice(0, 120));

  const extra = await call("list_permission_names", { surprise: 1 });
  check("undeclared argument is rejected", !extra.ok && extra.text.includes("Unknown argument"), extra.text.slice(0, 120));
} catch (err) {
  failures.push(err.message);
  console.error("smoke test crashed:", err.message);
} finally {
  child.kill();
  if (stderr.trim()) console.log("\nserver stderr:\n" + stderr.trim().slice(0, 1000));
  console.log(`\n${failures.length ? `FAILED (${failures.length}): ${failures.join("; ")}` : "all smoke checks passed"}`);
  process.exit(failures.length ? 1 : 0);
}
