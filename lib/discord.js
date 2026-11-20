// Minimal Discord REST API v10 client for the Discord MCP server.
// Uses global fetch (Node >= 18). Handles rate limits, transient failures,
// request timeouts and readable API errors.

const API = "https://discord.com/api/v10";

// Retries (including rate-limit waits) before giving up on one request.
const MAX_ATTEMPTS = 3;
// Never sleep longer than this for a single rate limit; longer waits surface as errors.
const MAX_RETRY_WAIT_MS = 30_000;
const REQUEST_TIMEOUT_MS = Number(process.env.DISCORD_HTTP_TIMEOUT_MS) || 20_000;

let token = null;

export function setToken(t) {
  token = t;
}

const STATUS_HINTS = {
  401: "The bot token is invalid or was reset.",
  403: "The bot lacks a permission, or the target role is above the bot's highest role.",
  404: "The guild, channel or role does not exist, or the bot is not a member of that guild.",
  429: "Discord is still rate limiting this request.",
};

/** Flatten Discord's nested `errors` object into "field: CODE" lines. */
function flattenErrors(node, prefix = "") {
  if (!node || typeof node !== "object") return [];
  const out = [];
  if (Array.isArray(node._errors)) {
    for (const error of node._errors) {
      out.push(`${prefix || "error"}: ${error.message ?? error.code ?? "invalid"}`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "_errors" || !value || typeof value !== "object") continue;
    out.push(...flattenErrors(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

function describeBody(body) {
  if (body === null || body === undefined) return "";
  if (typeof body !== "object") return String(body).slice(0, 300);
  const parts = [];
  if (body.code !== undefined) parts.push(`code ${body.code}`);
  if (body.message) parts.push(body.message);
  if (body.errors) {
    const details = flattenErrors(body.errors);
    if (details.length) parts.push(details.slice(0, 8).join("; "));
  }
  if (!parts.length) parts.push(JSON.stringify(body).slice(0, 300));
  return parts.join(" — ");
}

export class DiscordApiError extends Error {
  constructor(status, body, endpoint, method = "GET") {
    const detail = describeBody(body);
    const hint = STATUS_HINTS[status];
    super(
      `Discord API ${status} on ${method} ${endpoint}` +
        (detail ? ` — ${detail}` : "") +
        (hint ? ` (${hint})` : "")
    );
    this.name = "DiscordApiError";
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.method = method;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function send(method, endpoint, json) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(endpoint, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function finish(res, path, method) {
  if (res.status === 204) return undefined;
  const body = await readBody(res);
  if (!res.ok) throw new DiscordApiError(res.status, body, path, method);
  return body;
}

/**
 * Perform a REST request against Discord.
 * @param {string} method HTTP method
 * @param {string} path   endpoint path, e.g. `/guilds/{id}/channels`
 * @param {object} [json] JSON body (optional)
 * @returns {Promise<any>} parsed JSON response (or undefined for 204)
 */
export async function discordRequest(method, path, json) {
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set. Configure it in your MCP server environment.");
  }
  const endpoint = `${API}${path}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await send(method, endpoint, json);
    } catch (err) {
      const timedOut = err?.name === "AbortError";
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `${method} ${path} failed: ${
            timedOut ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message
          }`
        );
      }
      await sleep(400 * attempt);
      continue;
    }

    if (res.status === 429) {
      const body = await readBody(res);
      if (attempt === MAX_ATTEMPTS) throw new DiscordApiError(429, body, path, method);
      const retryAfter = Number(
        res.headers.get("retry-after") ?? body?.retry_after ?? 1
      );
      const waitMs = Math.min(Math.max(retryAfter, 0) * 1000, MAX_RETRY_WAIT_MS) + 250;
      await sleep(waitMs);
      continue;
    }

    // Discord occasionally returns 5xx for transient upstream errors — retry once or twice.
    if (res.status >= 500 && res.status !== 501 && attempt < MAX_ATTEMPTS) {
      await readBody(res);
      await sleep(500 * attempt);
      continue;
    }

    return finish(res, path, method);
  }

  throw new Error(`${method} ${path} failed after ${MAX_ATTEMPTS} attempts (rate limited).`);
}
