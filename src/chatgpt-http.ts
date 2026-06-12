#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SSHConfig } from "./index.js";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

const SERVER_NAME = "ssh-mcp-chatgpt";
const SERVER_VERSION = "1.5.0-chatgpt.0";
const STREAMABLE_HTTP_ACCEPT = "application/json, text/event-stream";
const MAX_BODY_BYTES = 1024 * 1024;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const SERVER_INSTRUCTIONS = [
  "This connector executes shell commands on one server-side configured SSH target.",
  "Do not ask the user to paste SSH passwords, private keys, or host credentials into ChatGPT; credentials are configured on the server with environment variables.",
  "Use the optional note argument on tool calls to explain why a command is being run. It is written to a redacted audit log when logging is enabled.",
  "Prefer precise, bounded commands. Avoid long-running interactive programs unless the deployment explicitly supports them.",
].join("\n");

class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "APP_ERROR",
  ) {
    super(message);
    this.name = "AppError";
  }
}

interface RuntimeConfig {
  port: number;
  dataDir: string;
  httpToken?: string;
  oauthBaseUrl?: string;
  oauthLoginSecret?: string;
  allowedOrigins: string[];
  toolCallLogEnabled: boolean;
  toolCallNoteRequired: boolean;
  disableSudo: boolean;
  sudoPassword?: string;
  maxChars: number;
}

interface ClientRegistration {
  redirectUris: Set<string>;
}

interface PendingAuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  expiresAt: number;
}

interface AccessTokenEntry {
  resource: string;
  expiresAt: number;
}

const clientRegistrations = new Map<string, ClientRegistration>();
const authCodes = new Map<string, PendingAuthCode>();
const accessTokens = new Map<string, AccessTokenEntry>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
  for (const [token, entry] of accessTokens) {
    if (entry.expiresAt < now) accessTokens.delete(token);
  }
}, 60_000);
cleanupTimer.unref?.();

function getEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function getRawEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(500, `${name} must be a positive integer`, "CONFIG_INVALID");
  }
  return parsed;
}

function parseMaxChars(value: string | undefined): number {
  if (!value) return 1000;
  if (value.toLowerCase() === "none") return Infinity;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1000;
  return parsed <= 0 ? Infinity : parsed;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function loadRuntimeConfig(): RuntimeConfig {
  const oauthBaseUrl = getEnv("OAUTH_BASE_URL", "SSH_MCP_OAUTH_BASE_URL")?.replace(/\/+$/, "");
  const oauthLoginSecret = getRawEnv("OAUTH_LOGIN_SECRET", "SSH_MCP_OAUTH_LOGIN_SECRET");

  if (oauthBaseUrl && !oauthLoginSecret) {
    throw new AppError(
      500,
      "OAUTH_LOGIN_SECRET is required when OAUTH_BASE_URL is configured",
      "CONFIG_INVALID",
    );
  }

  return {
    port: parseInteger(getEnv("PORT", "SSH_MCP_HTTP_PORT"), 3000, "PORT"),
    dataDir: getEnv("SSH_MCP_DATA_DIR", "DATA_DIR") ?? ".ssh-mcp-data",
    httpToken: getRawEnv("SSH_MCP_HTTP_TOKEN", "MCP_TOKEN"),
    oauthBaseUrl,
    oauthLoginSecret,
    allowedOrigins: parseCsv(
      getEnv("ALLOWED_ORIGINS", "SSH_MCP_ALLOWED_ORIGINS") ?? "https://chatgpt.com,https://chat.openai.com",
    ),
    toolCallLogEnabled: isEnabled(getEnv("SSH_MCP_TOOL_CALL_LOG_ENABLED"), true),
    toolCallNoteRequired: isEnabled(getEnv("SSH_MCP_TOOL_CALL_NOTE_REQUIRED"), false),
    disableSudo: isEnabled(getEnv("SSH_MCP_DISABLE_SUDO"), false),
    sudoPassword: getRawEnv("SSH_MCP_SUDO_PASSWORD", "SUDO_PASSWORD"),
    maxChars: parseMaxChars(getEnv("SSH_MCP_MAX_CHARS", "MAX_CHARS")),
  };
}

function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function requestUrl(req: IncomingMessage): URL {
  const host = getHeader(req.headers, "host") ?? "127.0.0.1";
  return new URL(req.url ?? "/", `http://${host}`);
}

function externalBaseUrl(req: IncomingMessage, config: RuntimeConfig): string {
  if (config.oauthBaseUrl) return config.oauthBaseUrl;
  const host = getHeader(req.headers, "x-forwarded-host") ?? getHeader(req.headers, "host") ?? "127.0.0.1";
  const proto = getHeader(req.headers, "x-forwarded-proto") ?? "http";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function isValidAccessToken(token: string, config: RuntimeConfig): boolean {
  if (constantTimeEqual(token, config.httpToken)) return true;
  const entry = accessTokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

function isAuthorized(req: IncomingMessage, config: RuntimeConfig): boolean {
  const token = extractBearerToken(getHeader(req.headers, "authorization"));
  if (!token) return !config.httpToken && !config.oauthBaseUrl;
  return isValidAccessToken(token, config);
}

function validateOrigin(req: IncomingMessage, config: RuntimeConfig): void {
  const origin = getHeader(req.headers, "origin");
  if (!origin) return;
  if (config.allowedOrigins.length === 0) return;
  if (!config.allowedOrigins.includes(origin)) {
    throw new AppError(403, "Origin is not allowed", "ORIGIN_FORBIDDEN");
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new AppError(413, "Request body too large", "BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new AppError(400, "Parse error", "PARSE_ERROR");
  }
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const body = await readBody(req);
  return new URLSearchParams(body.toString("utf8"));
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, statusCode: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, statusCode = 204, headers: Record<string, string> = {}): void {
  res.writeHead(statusCode, headers);
  res.end();
}

function sendUnauthorized(req: IncomingMessage, res: ServerResponse, config: RuntimeConfig): void {
  const baseUrl = externalBaseUrl(req, config);
  sendJson(
    res,
    401,
    { error: "Unauthorized", code: "UNAUTHORIZED" },
    { "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"` },
  );
}

function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "Expected JSON object", "INVALID_JSON_OBJECT");
  }
  return value as JsonObject;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, `${name} must be a non-empty string`, "INVALID_PARAMS");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function sanitizeCommand(command: string, maxChars: number): string {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new AppError(400, "Command cannot be empty", "INVALID_PARAMS");
  }
  if (Number.isFinite(maxChars) && trimmed.length > maxChars) {
    throw new AppError(400, `Command is too long (max ${maxChars} characters)`, "INVALID_PARAMS");
  }
  return trimmed;
}

function appendDescription(command: string, description?: string): string {
  if (!description) return command;
  const safeDescription = description.replace(/[\r\n]+/g, " ").replace(/#/g, "\\#");
  return `${command} # ${safeDescription}`;
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function textFromMcpResult(result: unknown): string {
  const object = result as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(object.content)) return "";
  return object.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
}

async function loadSshConfig(): Promise<SSHConfig> {
  const host = getEnv("SSH_MCP_HOST", "SSH_HOST");
  const user = getEnv("SSH_MCP_USER", "SSH_USER");
  if (!host || !user) {
    throw new AppError(
      500,
      "Missing SSH target configuration: set SSH_MCP_HOST and SSH_MCP_USER",
      "CONFIG_INVALID",
    );
  }

  const config: SSHConfig = {
    host,
    port: parseInteger(getEnv("SSH_MCP_PORT", "SSH_PORT"), 22, "SSH_MCP_PORT"),
    username: user,
  };

  const password = getRawEnv("SSH_MCP_PASSWORD", "SSH_PASSWORD");
  const privateKey = getRawEnv("SSH_MCP_PRIVATE_KEY", "SSH_PRIVATE_KEY")?.replace(/\\n/g, "\n");
  const privateKeyPath = getEnv("SSH_MCP_KEY", "SSH_KEY");

  if (password) {
    config.password = password;
  } else if (privateKey) {
    config.privateKey = privateKey;
  } else if (privateKeyPath) {
    config.privateKey = await readFile(privateKeyPath, "utf8");
  }

  return config;
}

async function loadSshModule(): Promise<typeof import("./index.js")> {
  process.env.SSH_MCP_DISABLE_MAIN = "1";
  return import("./index.js");
}

async function runSshTool(name: "exec" | "sudo-exec", args: JsonObject, config: RuntimeConfig): Promise<JsonObject> {
  const command = sanitizeCommand(requireString(args.command, "command"), config.maxChars);
  const description = optionalString(args.description);
  const commandWithDescription = appendDescription(command, description);

  let remoteCommand = commandWithDescription;
  if (name === "sudo-exec") {
    if (config.disableSudo) {
      throw new AppError(403, "sudo-exec is disabled on this deployment", "SUDO_DISABLED");
    }
    const quotedCommand = shellSingleQuote(commandWithDescription);
    if (config.sudoPassword) {
      remoteCommand = `printf '%s\\n' '${shellSingleQuote(config.sudoPassword)}' | sudo -p "" -S sh -c '${quotedCommand}'`;
    } else {
      remoteCommand = `sudo -n sh -c '${quotedCommand}'`;
    }
  }

  const sshConfig = await loadSshConfig();
  const { execSshCommand } = await loadSshModule();
  const result = await execSshCommand(sshConfig, remoteCommand);

  return {
    status: "completed",
    tool: name,
    stdout: textFromMcpResult(result),
    command_length: command.length,
  };
}

function redactArgs(args: JsonObject): JsonObject {
  const redacted: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    const lower = key.toLowerCase();
    if (lower.includes("password") || lower.includes("token") || lower.includes("key")) {
      redacted[key] = "[redacted]";
    } else if (key === "command" && typeof value === "string") {
      redacted[key] = `[redacted command, ${value.length} chars]`;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

async function auditToolCall(tool: string, args: JsonObject, sessionId: string, config: RuntimeConfig): Promise<void> {
  const note = optionalString(args.note);
  if (config.toolCallNoteRequired && !note) {
    throw new AppError(400, "note is required for tool calls on this deployment", "NOTE_REQUIRED");
  }
  if (!config.toolCallLogEnabled) return;

  const now = new Date();
  const dir = join(config.dataDir, "tool-calls");
  await mkdir(dir, { recursive: true });
  const record = {
    ts: now.toISOString(),
    session_id: sessionId,
    tool,
    note,
    arguments: redactArgs(args),
  };
  await appendFile(join(dir, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

function schema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    type: "object",
    properties: {
      ...properties,
      note: {
        type: "string",
        minLength: 1,
        description: "Optional audit note explaining why this tool call is being made.",
      },
    },
    required,
    additionalProperties: false,
  };
}

const HEALTH_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok"] },
    name: { type: "string" },
    version: { type: "string" },
    transports: { type: "array", items: { type: "string" } },
    endpoints: { type: "array", items: { type: "string" } },
    oauth_enabled: { type: "boolean" },
    static_bearer_enabled: { type: "boolean" },
    sudo_enabled: { type: "boolean" },
    audit_log_enabled: { type: "boolean" },
    note_required: { type: "boolean" },
    max_command_chars: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }] },
    ssh_target_configured: { type: "boolean" },
  },
  required: [
    "status",
    "name",
    "version",
    "transports",
    "endpoints",
    "oauth_enabled",
    "static_bearer_enabled",
    "sudo_enabled",
    "audit_log_enabled",
    "note_required",
    "max_command_chars",
    "ssh_target_configured",
  ],
  additionalProperties: false,
};

const COMMAND_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "failed"] },
    tool: { type: "string", enum: ["exec", "sudo-exec"] },
    stdout: { type: "string" },
    command_length: { type: "number" },
    error: { type: "string" },
    code: { type: "string" },
  },
  required: ["status"],
  additionalProperties: false,
};

function withSecurity(tool: JsonObject, securitySchemes: JsonObject[]): JsonObject {
  const currentMeta = tool._meta && typeof tool._meta === "object" && !Array.isArray(tool._meta) ? (tool._meta as JsonObject) : {};
  return {
    ...tool,
    securitySchemes,
    _meta: {
      ...currentMeta,
      securitySchemes,
    },
  };
}

function listTools(config: RuntimeConfig): JsonObject[] {
  const noAuth = [{ type: "noauth" }];
  const protectedSchemes = config.oauthBaseUrl ? [{ type: "oauth2", scopes: ["mcp"] }] : noAuth;

  const tools: JsonObject[] = [
    withSecurity(
      {
        name: "health",
        description: "Check whether the SSH MCP ChatGPT adapter is online and return non-secret deployment capabilities.",
        inputSchema: schema({}),
        outputSchema: HEALTH_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true },
      },
      noAuth,
    ),
    withSecurity(
      {
        name: "exec",
        description:
          "Execute a bounded shell command on the server-side configured SSH target. Credentials and target host are configured by the deployment, not by ChatGPT. Ask for confirmation before running destructive commands.",
        inputSchema: schema(
          {
            command: { type: "string", minLength: 1, description: "Shell command to execute on the configured SSH target." },
            description: { type: "string", description: "Optional legacy command comment appended on the remote shell." },
          },
          ["command"],
        ),
        outputSchema: COMMAND_OUTPUT_SCHEMA,
        _meta: {
          "openai/toolInvocation/invoking": "Running SSH command",
          "openai/toolInvocation/invoked": "SSH command finished",
        },
      },
      protectedSchemes,
    ),
  ];

  if (!config.disableSudo) {
    tools.push(
      withSecurity(
        {
          name: "sudo-exec",
          description:
            "Execute a bounded shell command through sudo on the server-side configured SSH target. Sudo credentials, when needed, are configured server-side. Ask for confirmation before running destructive commands.",
          inputSchema: schema(
            {
              command: { type: "string", minLength: 1, description: "Shell command to execute with sudo." },
              description: { type: "string", description: "Optional legacy command comment appended on the remote shell." },
            },
            ["command"],
          ),
          outputSchema: COMMAND_OUTPUT_SCHEMA,
          _meta: {
            "openai/toolInvocation/invoking": "Running sudo command",
            "openai/toolInvocation/invoked": "Sudo command finished",
          },
        },
        protectedSchemes,
      ),
    );
  }

  return tools;
}

function healthPayload(config: RuntimeConfig): JsonObject {
  return {
    status: "ok",
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transports: ["stdio", "streamable-http"],
    endpoints: ["/health", "/mcp"],
    oauth_enabled: Boolean(config.oauthBaseUrl),
    static_bearer_enabled: Boolean(config.httpToken),
    sudo_enabled: !config.disableSudo,
    audit_log_enabled: config.toolCallLogEnabled,
    note_required: config.toolCallNoteRequired,
    max_command_chars: Number.isFinite(config.maxChars) ? config.maxChars : "none",
    ssh_target_configured: Boolean(getEnv("SSH_MCP_HOST", "SSH_HOST") && getEnv("SSH_MCP_USER", "SSH_USER")),
  };
}

async function invokeTool(name: string, args: JsonObject, sessionId: string, config: RuntimeConfig): Promise<JsonObject> {
  await auditToolCall(name, args, sessionId, config);
  if (name === "health") return healthPayload(config);
  if (name === "exec" || name === "sudo-exec") return runSshTool(name, args, config);
  throw new AppError(404, `Unknown tool: ${name}`, "UNKNOWN_TOOL");
}

function getOrCreateSessionId(req: IncomingMessage): string {
  return getHeader(req.headers, "mcp-session-id")?.trim() || randomToken(18);
}

function assertStreamableAccept(req: IncomingMessage): void {
  const accept = getHeader(req.headers, "accept")?.toLowerCase() ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    throw new AppError(406, `Accept must include ${STREAMABLE_HTTP_ACCEPT}`, "ACCEPT_NOT_ACCEPTABLE");
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, config: RuntimeConfig): Promise<void> {
  if (req.method === "OPTIONS") {
    sendNoContent(res, 204, {
      "Access-Control-Allow-Origin": getHeader(req.headers, "origin") ?? "*",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    return;
  }

  if (req.method === "GET") {
    const accept = getHeader(req.headers, "accept")?.toLowerCase() ?? "";
    if (!accept.includes("text/event-stream")) {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    const sessionId = getOrCreateSessionId(req);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Mcp-Session-Id": sessionId,
    });
    res.write(`event: message\ndata: ${JSON.stringify({ type: "endpoint", status: "ready" })}\n\n`);
    res.end();
    return;
  }

  if (req.method === "DELETE") {
    sendNoContent(res);
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  assertStreamableAccept(req);
  validateOrigin(req, config);

  let request: JsonObject;
  try {
    request = asJsonObject(await readJsonBody(req));
  } catch (error) {
    if (error instanceof AppError && error.code === "PARSE_ERROR") {
      sendJson(res, 400, jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    throw error;
  }

  const id = (request.id ?? null) as JsonRpcId;
  const method = typeof request.method === "string" ? request.method : "";
  const sessionId = getOrCreateSessionId(req);
  const headers = { "Mcp-Session-Id": sessionId };

  if (method === "initialize") {
    sendJson(
      res,
      200,
      jsonRpcSuccess(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      }),
      headers,
    );
    return;
  }

  if (method === "notifications/initialized") {
    sendNoContent(res, 202, headers);
    return;
  }

  if (method === "tools/list") {
    sendJson(res, 200, jsonRpcSuccess(id, { tools: listTools(config) }), headers);
    return;
  }

  if (method === "tools/call") {
    const params = asJsonObject(request.params ?? {});
    const name = requireString(params.name, "name");
    const args = asJsonObject(params.arguments ?? {});

    if (name !== "health" && !isAuthorized(req, config)) {
      sendUnauthorized(req, res, config);
      return;
    }

    try {
      const structuredContent = await invokeTool(name, args, sessionId, config);
      sendJson(
        res,
        200,
        jsonRpcSuccess(id, {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        }),
        headers,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool call failed";
      const code = error instanceof AppError ? error.code : "TOOL_FAILED";
      sendJson(
        res,
        200,
        jsonRpcSuccess(id, {
          content: [{ type: "text", text: message }],
          structuredContent: { status: "failed", error: message, code },
          isError: true,
        }),
        headers,
      );
    }
    return;
  }

  sendJson(res, 200, jsonRpcError(id, -32601, `Method not found: ${method || "unknown"}`), headers);
}

function parseRedirectUri(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) return parsed;
    return null;
  } catch {
    return null;
  }
}

function registeredRedirectUris(value: unknown): { redirectUris: string[]; invalid: boolean } {
  if (!Array.isArray(value)) return { redirectUris: [], invalid: true };
  const seen = new Set<string>();
  const redirectUris: string[] = [];
  let invalid = false;
  for (const item of value) {
    if (typeof item !== "string" || !parseRedirectUri(item)) {
      invalid = true;
      continue;
    }
    if (!seen.has(item)) {
      seen.add(item);
      redirectUris.push(item);
    }
  }
  return { redirectUris, invalid };
}

function isRegisteredRedirectUri(clientId: string, redirectUri: string): boolean {
  return Boolean(clientRegistrations.get(clientId)?.redirectUris.has(redirectUri));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function authorizeHtml(params: URLSearchParams, failed = false): string {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`)
    .join("\n  ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize SSH MCP ChatGPT</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:520px;margin:72px auto;padding:0 20px;color:#202124;line-height:1.5}
h1{font-size:1.35rem;margin-bottom:8px}label{display:block;margin:16px 0 6px;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c7c7c7;border-radius:6px;font:inherit}
button{margin-top:18px;padding:10px 18px;border:0;border-radius:6px;background:#111827;color:white;font:inherit;cursor:pointer}.error{color:#b91c1c}
</style>
</head>
<body>
<h1>Authorize SSH MCP ChatGPT</h1>
<p>ChatGPT is requesting access to the configured SSH MCP connector.</p>
${failed ? '<p class="error">Invalid login secret. Try again.</p>' : ""}
<form method="POST" action="/authorize">
  ${hidden}
  <label for="secret">Login secret</label>
  <input id="secret" name="secret" type="password" autocomplete="off" required autofocus>
  <button type="submit">Authorize</button>
</form>
</body>
</html>`;
}

async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asJsonObject(await readJsonBody(req).catch(() => ({})));
  const parsed = registeredRedirectUris(body.redirect_uris);
  if (parsed.invalid || parsed.redirectUris.length === 0) {
    sendJson(res, 400, {
      error: "invalid_client_metadata",
      error_description: "redirect_uris must include at least one absolute http(s) URL",
    });
    return;
  }

  const clientId = `mcp-client-${randomToken(18)}`;
  clientRegistrations.set(clientId, { redirectUris: new Set(parsed.redirectUris) });
  sendJson(res, 200, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    redirect_uris: parsed.redirectUris,
  });
}

function oauthParamsFromUrl(req: IncomingMessage, config: RuntimeConfig): URLSearchParams {
  const url = requestUrl(req);
  const params = url.searchParams;
  if (!params.get("resource")) params.set("resource", externalBaseUrl(req, config));
  return params;
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, config: RuntimeConfig): Promise<void> {
  if (!config.oauthLoginSecret) {
    sendText(res, 500, "OAuth is not configured");
    return;
  }

  if (req.method === "GET") {
    const params = oauthParamsFromUrl(req, config);
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const codeChallenge = params.get("code_challenge") ?? "";
    if (!clientId || !redirectUri || !codeChallenge || !isRegisteredRedirectUri(clientId, redirectUri)) {
      sendText(res, 400, "Invalid OAuth request");
      return;
    }
    sendHtml(res, 200, authorizeHtml(params));
    return;
  }

  if (req.method !== "POST") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const form = await readFormBody(req);
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const codeChallenge = form.get("code_challenge") ?? "";
  const resource = form.get("resource") ?? externalBaseUrl(req, config);
  const state = form.get("state") ?? "";
  const secret = form.get("secret") ?? "";

  if (!clientId || !redirectUri || !codeChallenge || !isRegisteredRedirectUri(clientId, redirectUri)) {
    sendText(res, 400, "Invalid OAuth request");
    return;
  }

  if (!constantTimeEqual(secret, config.oauthLoginSecret)) {
    sendHtml(res, 403, authorizeHtml(form, true));
    return;
  }

  const code = randomToken(32);
  authCodes.set(code, {
    clientId,
    codeChallenge,
    redirectUri,
    resource,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const redirect = parseRedirectUri(redirectUri);
  if (!redirect) {
    sendText(res, 400, "Invalid redirect_uri");
    return;
  }
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  if (resource) redirect.searchParams.set("resource", resource);
  res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readFormBody(req);
  const grantType = form.get("grant_type") ?? "";
  const clientId = form.get("client_id") ?? "";
  const code = form.get("code") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const codeVerifier = form.get("code_verifier") ?? "";

  if (grantType !== "authorization_code") {
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }
  if (!clientRegistrations.has(clientId) || !isRegisteredRedirectUri(clientId, redirectUri)) {
    sendJson(res, 400, { error: "invalid_client" });
    return;
  }

  const entry = authCodes.get(code);
  authCodes.delete(code);
  if (!entry || entry.expiresAt < Date.now()) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "Invalid or expired authorization code" });
    return;
  }
  if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "Authorization code does not match client" });
    return;
  }
  if (sha256Base64Url(codeVerifier) !== entry.codeChallenge) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    return;
  }

  const accessToken = randomToken(48);
  accessTokens.set(accessToken, { resource: entry.resource, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: "mcp",
  });
}

async function route(req: IncomingMessage, res: ServerResponse, config: RuntimeConfig): Promise<void> {
  const url = requestUrl(req);
  const baseUrl = externalBaseUrl(req, config);

  if (req.method === "OPTIONS") {
    sendNoContent(res, 204, {
      "Access-Control-Allow-Origin": getHeader(req.headers, "origin") ?? "*",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, endpoints: ["/health", "/mcp"] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, healthPayload(config));
    return;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    sendJson(res, 200, {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      scopes_supported: ["mcp"],
      resource_documentation: `${baseUrl}/health`,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      client_id_metadata_document_supported: false,
    });
    return;
  }

  if (url.pathname === "/register" && req.method === "POST") {
    await handleRegister(req, res);
    return;
  }

  if (url.pathname === "/authorize") {
    await handleAuthorize(req, res, config);
    return;
  }

  if (url.pathname === "/token" && req.method === "POST") {
    await handleToken(req, res);
    return;
  }

  if (url.pathname === "/mcp") {
    await handleMcp(req, res, config);
    return;
  }

  sendText(res, 404, "Not Found");
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (process.env.NODE_ENV === "production" && !config.oauthBaseUrl && !config.httpToken) {
    throw new AppError(500, "Production deployments must set OAUTH_BASE_URL or SSH_MCP_HTTP_TOKEN", "CONFIG_INVALID");
  }

  const server = createServer((req, res) => {
    void route(req, res, config).catch((error) => {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : "Internal Server Error";
      const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
      sendJson(res, statusCode, { error: message, code });
    });
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`${SERVER_NAME} listening on :${config.port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

export { loadRuntimeConfig, listTools, healthPayload };
