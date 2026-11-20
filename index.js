#!/usr/bin/env node
/**
 * Discord MCP Server — server building & administration.
 *
 * Exposes tools to create/edit/delete categories, text/voice channels, roles,
 * and manage channel permission overwrites via the Discord REST API.
 *
 * Environment:
 *   DISCORD_BOT_TOKEN — a bot token from https://discord.com/developers/applications
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { discordRequest, setToken } from "./lib/discord.js";

// ---------------------------------------------------------------------------
// Discord permission bitfield (subset relevant to server building)
// ---------------------------------------------------------------------------
const PERMISSION_BITS = {
  ViewChannel: 1n << 10n,
  ManageChannels: 1n << 4n,
  ManageRoles: 1n << 28n,
  ManageGuild: 1n << 5n,
  ManageWebhooks: 1n << 29n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  AddReactions: 1n << 6n,
  UseExternalEmojis: 1n << 18n,
  MentionEveryone: 1n << 17n,
  ReadMessageHistory: 1n << 16n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVAD: 1n << 25n,
  Stream: 1n << 9n,
  PrioritySpeaker: 1n << 8n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n,
  UseSoundboard: 1n << 42n,
  CreateGuildExpressions: 1n << 43n,
  CreateEvents: 1n << 44n,
  SendVoiceMessages: 1n << 46n,
  SendPolls: 1n << 49n,
  UseExternalApps: 1n << 50n,
  Administrator: 1n << 3n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  CreateInvite: 1n << 0n,
  ManageMessages: 1n << 13n,
  ViewAuditLog: 1n << 7n,
  ViewGuildInsights: 1n << 19n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
};

/** Parse "ManageRoles, ManageChannels" into a bitfield string. */
function parsePermissions(str, label) {
  if (str === undefined || str === null || str === "" || str === "0") return "0";
  let bits = 0n;
  for (const raw of String(str).split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const bit = PERMISSION_BITS[name];
    if (bit === undefined) {
      throw new Error(
        `Unknown permission name "${name}" in ${label}. Call list_permission_names for valid names.`
      );
    }
    bits |= bit;
  }
  return bits.toString();
}

/** Names of the permissions contained in a bitfield. */
function permissionNamesOf(bits) {
  return Object.entries(PERMISSION_BITS)
    .filter(([, bit]) => (bits & bit) !== 0n)
    .map(([name]) => name);
}

const AUTOMOD_TRIGGER_NAMES = {
  1: "keyword",
  3: "spam",
  4: "keyword_preset",
  5: "mention_spam",
  6: "member_profile",
};

const AUTOMOD_ACTION_NAMES = {
  1: "block_message",
  2: "send_alert_message",
  3: "timeout",
};

// ---------------------------------------------------------------------------
// Argument validation
//
// MCP clients do not validate inputSchema for us, so a missing guild_id used to
// become "/guilds/undefined/channels" and an unvalidated ID could be injected
// straight into the request path. Validate every call against its own schema.
// ---------------------------------------------------------------------------
const SNOWFLAKE_RE = /^\d{17,20}$/;

function assertName(value, label, max = 100) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(`${label} must be at most ${max} characters (got ${trimmed.length}).`);
  }
  return trimmed;
}

function assertInt(value, label, min, max) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max} (got ${value}).`);
  }
  return value;
}

function validateValue(toolName, key, spec, value) {
  const label = `"${key}" for ${toolName}`;
  if (spec.enum && !spec.enum.includes(value)) {
    throw new Error(`Invalid ${label}: expected one of ${spec.enum.join(", ")} (got ${JSON.stringify(value)}).`);
  }
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        throw new Error(`Invalid ${label}: expected a string, got ${Array.isArray(value) ? "array" : typeof value}.`);
      }
      if (key.endsWith("_id") && !SNOWFLAKE_RE.test(value)) {
        throw new Error(
          `Invalid ${label}: "${value}" is not a Discord ID. Enable Developer Mode and copy the numeric ID (17-20 digits).`
        );
      }
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Invalid ${label}: expected a number, got ${JSON.stringify(value)}.`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(`Invalid ${label}: expected true or false, got ${JSON.stringify(value)}.`);
      }
      return;
    case "array": {
      if (!Array.isArray(value)) {
        throw new Error(`Invalid ${label}: expected an array, got ${typeof value}.`);
      }
      const itemSpec = spec.items ?? {};
      value.forEach((item, index) => {
        if (itemSpec.type === "object") {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new Error(`Invalid ${label}[${index}]: expected an object.`);
          }
          for (const req of itemSpec.required ?? []) {
            if (item[req] === undefined) {
              throw new Error(`Invalid ${label}[${index}]: missing required "${req}".`);
            }
          }
          for (const [itemKey, itemSpecProp] of Object.entries(itemSpec.properties ?? {})) {
            if (item[itemKey] !== undefined) {
              validateValue(toolName, itemKey, itemSpecProp, item[itemKey]);
            }
          }
        } else if (itemSpec.type) {
          validateValue(toolName, key, itemSpec, item);
        }
      });
      return;
    }
    default:
      return;
  }
}

function validateArgs(tool, args) {
  const { properties = {}, required = [], additionalProperties } = tool.inputSchema ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Arguments for ${tool.name} must be an object.`);
  }
  for (const key of required) {
    if (args[key] === undefined) {
      throw new Error(`Missing required argument "${key}" for ${tool.name}.`);
    }
  }
  if (additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        throw new Error(
          `Unknown argument "${key}" for ${tool.name}. Valid arguments: ${
            Object.keys(properties).join(", ") || "(none)"
          }.`
        );
      }
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (args[key] !== undefined) validateValue(tool.name, key, spec, args[key]);
  }
}

/** Find which guild owns a role when the caller did not pass guild_id. */
async function resolveGuildForRole(roleId) {
  const guilds = await discordRequest("GET", "/users/@me/guilds");
  for (const guild of guilds) {
    try {
      const roles = await discordRequest("GET", `/guilds/${guild.id}/roles`);
      if (roles.some((role) => role.id === roleId)) return guild.id;
    } catch {
      // No access to this guild — keep looking.
    }
  }
  throw new Error(
    `Could not find role ${roleId} in any guild this bot belongs to. Pass guild_id explicitly.`
  );
}

/** Fetch a role's guild, using the explicit guild_id when provided. */
async function roleGuildId(args) {
  return args.guild_id ?? (await resolveGuildForRole(args.role_id));
}

// ---------------------------------------------------------------------------
// Tool schemas (plain JSON Schema — no zod)
// ---------------------------------------------------------------------------
const guildIdProp = {
  type: "string",
  description: "The guild (server) ID. Right-click a server > 'Copy Server ID' with Developer Mode enabled.",
};

const TOOLS = [
  // --- discovery ---
  {
    name: "list_guilds",
    description: "List all Discord servers (guilds) the bot is a member of, with their IDs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_channels",
    description:
      "List every channel in a guild: categories, text, voice, forum and announcement channels, with IDs, names, types and parent IDs.",
    inputSchema: {
      type: "object",
      properties: { guild_id: guildIdProp },
      required: ["guild_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_roles",
    description: "List every role in a guild with IDs, names, colors, hoist/mentionable flags and position.",
    inputSchema: {
      type: "object",
      properties: { guild_id: guildIdProp },
      required: ["guild_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_permission_names",
    description: "List valid permission names accepted by create_role / edit_role / set_channel_permissions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },

  // --- categories ---
  {
    name: "create_category",
    description: "Create a channel category in a guild. Channels can be placed under it via parent_id.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        name: { type: "string", description: "Category name (1–100 chars)." },
      },
      required: ["guild_id", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_category",
    description: "Rename a category and/or move its position.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The category's channel ID." },
        name: { type: "string", description: "New category name." },
        position: { type: "number", description: "New position among categories (0 = top)." },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_category",
    description: "Delete a category. Channels inside it lose their parent but are NOT deleted.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The category's channel ID." },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },

  // --- channels ---
  {
    name: "create_text_channel",
    description: "Create a text channel in a guild, optionally inside a category.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        name: { type: "string", description: "Channel name (1–100 chars, lowercase words ok)." },
        parent_id: { type: "string", description: "Optional category ID to place the channel in." },
        topic: { type: "string", description: "Optional channel topic (0–1024 chars)." },
        nsfw: { type: "boolean", description: "Mark channel as age-restricted." },
        slowmode: {
          type: "number",
          description: "Seconds between messages per user (0–21600). 0 disables.",
        },
      },
      required: ["guild_id", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "create_voice_channel",
    description: "Create a voice channel in a guild, optionally inside a category.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        name: { type: "string", description: "Channel name (1–100 chars)." },
        parent_id: { type: "string", description: "Optional category ID to place the channel in." },
        bitrate: { type: "number", description: "Audio bitrate in bits/s (8000–384000 depending on tier)." },
        user_limit: { type: "number", description: "Max users in the voice channel (0 = unlimited, max 99)." },
        nsfw: { type: "boolean", description: "Mark channel as age-restricted." },
      },
      required: ["guild_id", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_channel",
    description:
      "Edit an existing channel: rename, change topic, slowmode, nsfw, bitrate, user_limit, move to another category (parent_id) or move position.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The channel ID to edit." },
        name: { type: "string", description: "New channel name." },
        topic: { type: "string", description: "New topic (text channels only)." },
        nsfw: { type: "boolean" },
        slowmode: { type: "number", description: "Seconds between messages (0–21600), text only." },
        bitrate: { type: "number", description: "Audio bitrate in bits/s, voice only." },
        user_limit: { type: "number", description: "Max users (0 = unlimited), voice only." },
        parent_id: { type: "string", description: "Category ID to move the channel into." },
        position: { type: "number", description: "Position within its category." },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_channel",
    description: "Delete a channel (text, voice or category). This is permanent — confirm intent before calling.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The channel ID to delete." },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },

  // --- roles ---
  {
    name: "create_role",
    description:
      "Create a role in a guild. Permissions accept a comma-separated list of permission names (see list_permission_names).",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        name: { type: "string", description: "Role name." },
        color: {
          type: "string",
          description: 'Hex color like "#5865F2" or integer color. Omit for default.',
        },
        permissions: {
          type: "string",
          description: 'Comma-separated permission names, e.g. "ViewChannel, SendMessages". Defaults to no permissions.',
        },
        hoist: { type: "boolean", description: "Display role members separately in the member list." },
        mentionable: { type: "boolean", description: "Allow anyone to @mention this role." },
      },
      required: ["guild_id", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_role",
    description: "Edit an existing role: name, color, permissions, hoist, mentionable.",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "string", description: "The role ID to edit." },
        guild_id: {
          type: "string",
          description: "Optional guild ID. Omit to look the role up across the bot's guilds.",
        },
        name: { type: "string" },
        color: { type: "string", description: 'Hex color like "#eb459e" or integer.' },
        permissions: { type: "string", description: "Comma-separated permission names (replaces ALL permissions)." },
        hoist: { type: "boolean" },
        mentionable: { type: "boolean" },
      },
      required: ["role_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_role",
    description: "Delete a role. This is permanent — confirm intent before calling.",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "string", description: "The role ID to delete." },
        guild_id: {
          type: "string",
          description: "Optional guild ID. Omit to look the role up across the bot's guilds.",
        },
      },
      required: ["role_id"],
      additionalProperties: false,
    },
  },

  // --- channel permissions ---
  {
    name: "set_channel_permissions",
    description:
      "Create or update a permission overwrite on a channel for a role or a member. " +
      "allow/deny accept comma-separated permission names. mode 'set' replaces the overwrite, 'update' merges into it.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The channel to modify permissions on." },
        target_type: { type: "string", enum: ["role", "member"], description: "Whether target_id is a role ID or user ID." },
        target_id: { type: "string", description: "The role ID or user (member) ID." },
        allow: { type: "string", description: 'Comma-separated permissions to allow, e.g. "ViewChannel, SendMessages".' },
        deny: { type: "string", description: 'Comma-separated permissions to deny, e.g. "Connect, Speak".' },
        mode: { type: "string", enum: ["set", "update"], description: "'set' replaces the overwrite entirely; 'update' merges (default)." },
      },
      required: ["channel_id", "target_type", "target_id"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_channel_permissions",
    description: "Remove a role or member permission overwrite from a channel entirely.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The channel to modify." },
        target_id: { type: "string", description: "The role ID or user ID whose overwrite should be removed." },
      },
      required: ["channel_id", "target_id"],
      additionalProperties: false,
    },
  },

  // --- guild / roles / messaging ---
  {
    name: "edit_guild",
    description: "Rename the server and/or update its description. Icon changes require image upload and are not supported.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        name: { type: "string", description: "New server name (2–100 chars)." },
        description: { type: "string", description: "Server description (optional, max 300 chars)." },
      },
      required: ["guild_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_role_positions",
    description:
      "Reorder roles by position (higher number = higher in the hierarchy). Requires the bot's own role to be above the roles being moved.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        positions: {
          type: "array",
          description: "Roles to reposition, highest position first.",
          items: {
            type: "object",
            properties: {
              role_id: { type: "string" },
              position: { type: "number", description: "Target position (1+; @everyone is fixed at 0)." },
            },
            required: ["role_id", "position"],
            additionalProperties: false,
          },
        },
      },
      required: ["guild_id", "positions"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description: "Send a message to a channel (e.g. a welcome message). Returns the message ID.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Target channel ID." },
        content: { type: "string", description: "Message content (max 2000 chars). Markdown supported." },
      },
      required: ["channel_id", "content"],
      additionalProperties: false,
    },
  },

  // --- AutoMod ---
  {
    name: "create_automod_rule",
    description:
      "Create an AutoMod rule for spam/moderation protection. trigger_type 'keyword' supports keywords, regex_patterns and presets; 'mention_spam' uses mention_limit.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        name: { type: "string", description: "Rule name shown in Server Settings > AutoMod." },
        trigger_type: { type: "string", enum: ["keyword", "mention_spam"], description: "What triggers the rule." },
        keywords: { type: "array", items: { type: "string" }, description: "Blocked words/phrases (keyword trigger)." },
        regex_patterns: { type: "array", items: { type: "string" }, description: "Regex patterns to block (keyword trigger)." },
        presets: {
          type: "array",
          items: { type: "string", enum: ["profanity", "sexual_content", "slurs"] },
          description: "Discord's built-in keyword presets.",
        },
        mention_limit: { type: "number", description: "Max mentions per message before triggering (mention_spam trigger)." },
        action: { type: "string", enum: ["block", "timeout", "alert"], description: "What to do when triggered. Defaults to block." },
        timeout_seconds: { type: "number", description: "Timeout duration when action is 'timeout' (60–2419200)." },
        alert_channel_id: { type: "string", description: "Channel to send alert messages to (for 'alert' or alongside block)." },
        exempt_roles: { type: "array", items: { type: "string" }, description: "Role IDs exempt from this rule (e.g. staff)." },
        exempt_channels: { type: "array", items: { type: "string" }, description: "Channel IDs exempt from this rule." },
      },
      required: ["guild_id", "name", "trigger_type"],
      additionalProperties: false,
    },
  },
  {
    name: "list_automod_rules",
    description: "List all AutoMod rules configured in a guild.",
    inputSchema: {
      type: "object",
      properties: { guild_id: guildIdProp },
      required: ["guild_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_automod_rule",
    description: "Delete an AutoMod rule by ID.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: guildIdProp,
        rule_id: { type: "string", description: "The AutoMod rule ID." },
      },
      required: ["guild_id", "rule_id"],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "discord-mcp", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Server building & administration tools for Discord. Use list_guilds / list_channels / " +
      "list_roles first to resolve IDs, and list_permission_names before passing permissions. " +
      "Delete operations are permanent.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params ?? {};
  try {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    validateArgs(tool, args ?? {});
    const data = await callTool(name, args ?? {});
    const text =
      data === undefined ? "OK (no content returned)" : JSON.stringify(data, null, 2);
    return {
      content: [{ type: "text", text }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
    };
  }
});

async function callTool(name, args) {
  switch (name) {
    case "list_guilds":
      return discordRequest("GET", "/users/@me/guilds");

    case "list_channels": {
      const channels = await discordRequest("GET", `/guilds/${args.guild_id}/channels`);
      return channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: channelTypeName(c.type),
        parent_id: c.parent_id ?? null,
        position: c.position,
      }));
    }

    case "list_roles": {
      const roles = await discordRequest("GET", `/guilds/${args.guild_id}/roles`);
      return roles
        .map((r) => ({
          id: r.id,
          name: r.name,
          color: `#${r.color.toString(16).padStart(6, "0")}`,
          hoist: r.hoist,
          mentionable: r.mentionable,
          position: r.position,
          managed: r.managed,
        }))
        .sort((a, b) => b.position - a.position);
    }

    case "list_permission_names":
      return { permissions: Object.keys(PERMISSION_BITS).sort() };

    case "create_category":
      return discordRequest("POST", `/guilds/${args.guild_id}/channels`, {
        name: assertName(args.name, "Category name"),
        type: 4, // GUILD_CATEGORY
      });

    case "edit_category": {
      const body = {};
      if (args.name !== undefined) body.name = assertName(args.name, "Category name");
      if (args.position !== undefined) body.position = assertInt(args.position, "position", 0, 1000);
      if (Object.keys(body).length === 0) {
        throw new Error("edit_category needs at least one of name or position.");
      }
      return discordRequest("PATCH", `/channels/${args.channel_id}`, body);
    }

    case "delete_category":
      await discordRequest("DELETE", `/channels/${args.channel_id}`);
      return { deleted: true, channel_id: args.channel_id };

    case "create_text_channel": {
      const body = { name: assertName(args.name, "Channel name"), type: 0 }; // GUILD_TEXT
      if (args.parent_id !== undefined) body.parent_id = args.parent_id;
      if (args.topic !== undefined) {
        if (typeof args.topic !== "string" || args.topic.length > 1024) {
          throw new Error("topic must be a string of at most 1024 characters.");
        }
        body.topic = args.topic;
      }
      if (args.nsfw !== undefined) body.nsfw = args.nsfw;
      if (args.slowmode !== undefined) {
        body.rate_limit_per_user = assertInt(args.slowmode, "slowmode", 0, 21600);
      }
      return discordRequest("POST", `/guilds/${args.guild_id}/channels`, body);
    }

    case "create_voice_channel": {
      const body = { name: assertName(args.name, "Channel name"), type: 2 }; // GUILD_VOICE
      if (args.parent_id !== undefined) body.parent_id = args.parent_id;
      if (args.bitrate !== undefined) body.bitrate = assertInt(args.bitrate, "bitrate", 8000, 384000);
      if (args.user_limit !== undefined) body.user_limit = assertInt(args.user_limit, "user_limit", 0, 99);
      if (args.nsfw !== undefined) body.nsfw = args.nsfw;
      return discordRequest("POST", `/guilds/${args.guild_id}/channels`, body);
    }

    case "edit_channel": {
      const body = {};
      if (args.name !== undefined) body.name = assertName(args.name, "Channel name");
      if (args.topic !== undefined) {
        if (typeof args.topic !== "string" || args.topic.length > 1024) {
          throw new Error("topic must be a string of at most 1024 characters.");
        }
        body.topic = args.topic;
      }
      if (args.nsfw !== undefined) body.nsfw = args.nsfw;
      if (args.slowmode !== undefined) {
        body.rate_limit_per_user = assertInt(args.slowmode, "slowmode", 0, 21600);
      }
      if (args.bitrate !== undefined) body.bitrate = assertInt(args.bitrate, "bitrate", 8000, 384000);
      if (args.user_limit !== undefined) body.user_limit = assertInt(args.user_limit, "user_limit", 0, 99);
      if (args.parent_id !== undefined) body.parent_id = args.parent_id;
      if (args.position !== undefined) body.position = assertInt(args.position, "position", 0, 1000);
      if (Object.keys(body).length === 0) {
        throw new Error("edit_channel needs at least one field to change.");
      }
      return discordRequest("PATCH", `/channels/${args.channel_id}`, body);
    }

    case "delete_channel":
      await discordRequest("DELETE", `/channels/${args.channel_id}`);
      return { deleted: true, channel_id: args.channel_id };

    case "create_role": {
      const body = {
        name: assertName(args.name, "Role name"),
        permissions: parsePermissions(args.permissions ?? "", "permissions"),
      };
      if (args.color !== undefined) body.color = parseColor(args.color);
      if (args.hoist !== undefined) body.hoist = args.hoist;
      if (args.mentionable !== undefined) body.mentionable = args.mentionable;
      return discordRequest("POST", `/guilds/${args.guild_id}/roles`, body);
    }

    case "edit_role": {
      const body = {};
      if (args.name !== undefined) body.name = assertName(args.name, "Role name");
      if (args.color !== undefined) body.color = parseColor(args.color);
      if (args.permissions !== undefined) body.permissions = parsePermissions(args.permissions, "permissions");
      if (args.hoist !== undefined) body.hoist = args.hoist;
      if (args.mentionable !== undefined) body.mentionable = args.mentionable;
      if (Object.keys(body).length === 0) {
        throw new Error("edit_role needs at least one of name, color, permissions, hoist or mentionable.");
      }
      const guildId = await roleGuildId(args);
      return discordRequest("PATCH", `/guilds/${guildId}/roles/${args.role_id}`, body);
    }

    case "delete_role": {
      const guildId = await roleGuildId(args);
      await discordRequest("DELETE", `/guilds/${guildId}/roles/${args.role_id}`);
      return { deleted: true, role_id: args.role_id };
    }

    case "set_channel_permissions": {
      const allowBits = BigInt(parsePermissions(args.allow ?? "", "allow"));
      const denyBits = BigInt(parsePermissions(args.deny ?? "", "deny"));
      const overlap = allowBits & denyBits;
      if (overlap !== 0n) {
        throw new Error(
          `Cannot allow and deny the same permission: ${permissionNamesOf(overlap).join(
            ", "
          )}. Remove it from one of the lists.`
        );
      }

      const mode = args.mode ?? "update";
      const type = args.target_type === "member" ? 1 : 0; // 0 = role, 1 = member
      const channel = await discordRequest("GET", `/channels/${args.channel_id}`);
      const existing = (channel.permission_overwrites || []).find(
        (o) => o.id === args.target_id
      );
      const baseAllow = mode === "set" || !existing ? 0n : BigInt(existing.allow);
      const baseDeny = mode === "set" || !existing ? 0n : BigInt(existing.deny);

      // The bits named in this call win; a permission is never both allowed and denied.
      const allow = (baseAllow | allowBits) & ~denyBits;
      const deny = (baseDeny | denyBits) & ~allowBits;

      await discordRequest(
        "PUT",
        `/channels/${args.channel_id}/permissions/${args.target_id}`,
        { allow: allow.toString(), deny: deny.toString(), type }
      );
      // Return the channel so the caller can verify the resulting overwrites.
      return discordRequest("GET", `/channels/${args.channel_id}`);
    }

    case "remove_channel_permissions": {
      await discordRequest(
        "DELETE",
        `/channels/${args.channel_id}/permissions/${args.target_id}`
      );
      return discordRequest("GET", `/channels/${args.channel_id}`);
    }

    case "edit_guild": {
      const body = {};
      if (args.name !== undefined) {
        if (typeof args.name !== "string" || args.name.trim().length < 2) {
          throw new Error("Server name must be at least 2 characters.");
        }
        body.name = assertName(args.name, "Server name", 100);
      }
      if (args.description !== undefined) {
        if (typeof args.description !== "string" || args.description.length > 300) {
          throw new Error("Server description must be a string of at most 300 characters.");
        }
        body.description = args.description;
      }
      if (Object.keys(body).length === 0) {
        throw new Error("edit_guild needs at least one of name or description.");
      }
      return discordRequest("PATCH", `/guilds/${args.guild_id}`, body);
    }

    case "set_role_positions": {
      if (args.positions.length === 0) {
        throw new Error("positions must contain at least one role.");
      }
      for (const entry of args.positions) {
        if (entry.role_id === args.guild_id) {
          throw new Error("@everyone is always position 0 and cannot be moved.");
        }
        assertInt(entry.position, "position", 0, 1000);
      }
      return discordRequest(
        "PATCH",
        `/guilds/${args.guild_id}/roles`,
        args.positions.map((p) => ({ id: p.role_id, position: p.position }))
      );
    }

    case "send_message": {
      const content = args.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("Message content must be a non-empty string.");
      }
      if (content.length > 2000) {
        throw new Error(`Message content must be at most 2000 characters (got ${content.length}).`);
      }
      return discordRequest("POST", `/channels/${args.channel_id}/messages`, { content });
    }

    case "create_automod_rule": {
      const actions = [];
      const action = args.action ?? "block";
      if (action === "block") {
        actions.push({
          type: 1,
          metadata: { custom_message: `Message blocked by AutoMod rule "${args.name}".` },
        });
      } else if (action === "timeout") {
        actions.push({
          type: 3,
          metadata: { duration_seconds: assertInt(args.timeout_seconds ?? 300, "timeout_seconds", 60, 2419200) },
        });
      } else if (action === "alert") {
        if (!args.alert_channel_id) {
          throw new Error("alert_channel_id is required when action is 'alert'.");
        }
        actions.push({ type: 2, metadata: { channel_id: args.alert_channel_id } });
      }
      if (args.alert_channel_id && action !== "alert") {
        actions.push({ type: 2, metadata: { channel_id: args.alert_channel_id } });
      }

      const keywords = (args.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
      const regexes = (args.regex_patterns ?? []).map((r) => String(r).trim()).filter(Boolean);
      const presets = args.presets ?? [];
      const triggerMetadata = {};
      let triggerType; // 1 KEYWORD, 3 SPAM, 4 KEYWORD_PRESET, 5 MENTION_SPAM, 6 MEMBER_PROFILE

      if (args.trigger_type === "mention_spam") {
        triggerType = 5;
        triggerMetadata.mention_total_limit = assertInt(
          args.mention_limit ?? 5,
          "mention_limit",
          1,
          100
        );
      } else if (presets.length) {
        // Discord rejects keyword_filter/regex alongside presets, so they are exclusive.
        if (keywords.length || regexes.length) {
          throw new Error(
            "Use either presets or keywords/regex_patterns, not both — Discord does not allow keyword filters on preset rules."
          );
        }
        const presetMap = { profanity: 1, sexual_content: 2, slurs: 3 };
        triggerType = 4;
        triggerMetadata.presets = presets.map((preset) => presetMap[preset]);
      } else if (keywords.length || regexes.length) {
        triggerType = 1;
        if (keywords.some((k) => k.length > 60)) {
          throw new Error("Each keyword must be at most 60 characters.");
        }
        if (keywords.length > 1000) throw new Error("A rule can hold at most 1000 keywords.");
        if (keywords.length) triggerMetadata.keyword_filter = keywords;
        if (regexes.length) triggerMetadata.regex_patterns = regexes;
      } else {
        throw new Error(
          "trigger_type 'keyword' needs keywords or regex_patterns (or presets); trigger_type 'mention_spam' needs mention_limit."
        );
      }

      const body = {
        name: assertName(args.name, "AutoMod rule name"),
        event_type: 1, // MESSAGE_SEND
        trigger_type: triggerType,
        trigger_metadata: triggerMetadata,
        actions,
        enabled: true,
      };
      if (args.exempt_roles?.length) body.exempt_roles = args.exempt_roles;
      if (args.exempt_channels?.length) body.exempt_channels = args.exempt_channels;
      return discordRequest("POST", `/guilds/${args.guild_id}/auto-moderation/rules`, body);
    }

    case "list_automod_rules": {
      const rules = await discordRequest("GET", `/guilds/${args.guild_id}/auto-moderation/rules`);
      return rules.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        trigger_type: AUTOMOD_TRIGGER_NAMES[r.trigger_type] ?? `type_${r.trigger_type}`,
        trigger_metadata: r.trigger_metadata,
        actions: r.actions.map((a) => ({
          type: AUTOMOD_ACTION_NAMES[a.type] ?? `type_${a.type}`,
          metadata: a.metadata,
        })),
      }));
    }

    case "delete_automod_rule":
      await discordRequest("DELETE", `/guilds/${args.guild_id}/auto-moderation/rules/${args.rule_id}`);
      return { deleted: true, rule_id: args.rule_id };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseColor(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) {
    const value = Number(s);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
      throw new Error(`Color ${value} is out of range. Use 0-16777215 or a hex string like "#5865F2".`);
    }
    return value;
  }
  const hex = s.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
  throw new Error(`Invalid color "${input}". Use a hex string like "#5865F2" or an integer.`);
}

function channelTypeName(type) {
  const types = {
    0: "text",
    1: "dm",
    2: "voice",
    3: "group_dm",
    4: "category",
    5: "announcement",
    10: "announcement_thread",
    11: "public_thread",
    12: "private_thread",
    13: "stage",
    14: "directory",
    15: "forum",
    16: "media",
  };
  return types[type] ?? `type_${type}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error(
    "discord-mcp: DISCORD_BOT_TOKEN environment variable is required.\n" +
      "Get one at https://discord.com/developers/applications > your app > Bot > Token."
  );
  process.exit(1);
}
setToken(token);

process.on("unhandledRejection", (err) => {
  console.error("discord-mcp: unhandled rejection:", err instanceof Error ? err.message : err);
});
process.on("uncaughtException", (err) => {
  console.error("discord-mcp: uncaught exception:", err?.stack ?? err);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    try {
      await server.close();
    } catch { /* already closed */ }
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
console.error("discord-mcp: server running on stdio");
