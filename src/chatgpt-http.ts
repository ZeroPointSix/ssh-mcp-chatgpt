#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, type ClientChannel } from "ssh2";
import type { SSHConfig } from "./index.js";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

const SERVER_NAME = "ssh-mcp-chatgpt";
const SERVER_VERSION = "1.5.0-chatgpt.0";
const STREAMABLE_HTTP_ACCEPT = "application/json, text/event-stream";
const MAX_BODY_BYTES = 1024 * 1024;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_EXEC_EXPIRE_TIME_MS = 55_000;
const DEFAULT_EXEC_OUTPUT_MAX_CHARS = 200_000;
const COMMAND_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

const SERVER_INSTRUCTIONS = [
  "This connector executes shell commands on server-side configured SSH profiles.",
  "Use list-profiles to see the available profile IDs and labels before selecting a non-default target.",
  "Do not ask the user to paste SSH passwords, private keys, hostnames, or host credentials into ChatGPT; credentials and routing details are configured on the server.",
  "Use the optional note argument on tool calls to explain why a command is being run. It is written to a redacted audit log when logging is enabled.",
  "Long-running commands return a job_id after expire_time_ms and continue in the background. Use exec-status to poll and exec-cancel to request stopping, then poll until a final status is confirmed.",
  "Prefer precise, non-interactive commands. Ask for confirmation before destructive operations.",
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
  execExpireTimeMs: number;
  execKillTimeMs?: number;
  execOutputMaxChars: number;
  sshProfiles: SshProfileConfig[];
  defaultSshProfileId?: string;
}

interface SshProfileConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  sudoEnabled: boolean;
  default: boolean;
}

interface PublicSshProfile {
  id: string;
  label: string;
  sudo_enabled: boolean;
  default: boolean;
}

interface ResolvedSshTarget {
  id: string;
  label: string;
  sudoEnabled: boolean;
  profile?: SshProfileConfig;
}

const LEGACY_TARGET_ID = "default";

type CommandTool = "exec" | "sudo-exec";
type CommandJobTerminalStatus = "completed" | "failed" | "killed" | "cancelled";
type CommandJobStopStatus = "killed" | "cancelled";
type CommandJobStatus = "running" | "cancelling" | "kill_requested" | CommandJobTerminalStatus;

interface CommandJob {
  id: string;
  tool: CommandTool;
  targetId: string;
  targetLabel: string;
  commandLength: number;
  status: CommandJobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  expireTimeMs: number;
  killTimeMs?: number;
  outputMaxChars: number;
  stdout: string;
  stderr: string;
  stdoutChars: number;
  stderrChars: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  stopRequestedStatus?: CommandJobStopStatus;
  stopRequestedAt?: number;
  stopReason?: string;
  stopSignalSent?: boolean;
  stopError?: string;
  conn?: Client;
  stream?: ClientChannel;
  killTimer?: NodeJS.Timeout;
  waiters: Set<() => void>;
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

const OAUTH_PREFIX_MARKER = "prefix:";

const clientRegistrations = new Map<string, ClientRegistration>();
const authCodes = new Map<string, PendingAuthCode>();
const accessTokens = new Map<string, AccessTokenEntry>();
const commandJobs = new Map<string, CommandJob>();

function oauthPrefixEntry(prefix: string): string {
  return `${OAUTH_PREFIX_MARKER}${prefix}`;
}

function oauthMatchesRedirectUri(registration: ClientRegistration, redirectUri: string): boolean {
  if (registration.redirectUris.has(redirectUri)) return true;
  for (const entry of registration.redirectUris) {
    if (entry.startsWith(OAUTH_PREFIX_MARKER) && redirectUri.startsWith(entry.slice(OAUTH_PREFIX_MARKER.length))) {
      return true;
    }
  }
  return false;
}

function mergeClientRegistration(clientId: string, redirectUris: Iterable<string>): void {
  const existing = clientRegistrations.get(clientId);
  const merged = existing ? new Set(existing.redirectUris) : new Set<string>();
  for (const uri of redirectUris) merged.add(uri);
  clientRegistrations.set(clientId, { redirectUris: merged });
}

async function loadOAuthClientRegistrations(dataDir: string): Promise<void> {
  const filePath = join(dataDir, "oauth-clients.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { clients?: Record<string, string[]> };
    for (const [clientId, uris] of Object.entries(parsed.clients ?? {})) {
      if (Array.isArray(uris) && uris.length > 0) {
        mergeClientRegistration(clientId, uris);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[oauth] failed to load client registrations:", error);
    }
  }
}

async function persistOAuthClientRegistrations(dataDir: string): Promise<void> {
  const filePath = join(dataDir, "oauth-clients.json");
  try {
    await mkdir(dataDir, { recursive: true });
    const clients: Record<string, string[]> = {};
    for (const [clientId, registration] of clientRegistrations) {
      clients[clientId] = [...registration.redirectUris];
    }
    await writeFile(filePath, `${JSON.stringify({ clients }, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("[oauth] failed to persist client registrations:", error);
  }
}

async function bootstrapOAuthClients(config: RuntimeConfig): Promise<void> {
  if (!config.oauthBaseUrl) return;
  await loadOAuthClientRegistrations(config.dataDir);

  const bootstrapRaw = process.env.OAUTH_BOOTSTRAP_CLIENT_ID;
  const bootstrapClientId = bootstrapRaw === "" ? "" : (bootstrapRaw?.trim() || "mcp-client-chatgpt");
  if (!bootstrapClientId) return;

  const prefixes = parseCsv(getEnv("OAUTH_BOOTSTRAP_REDIRECT_URI_PREFIXES")).length
    ? parseCsv(getEnv("OAUTH_BOOTSTRAP_REDIRECT_URI_PREFIXES"))
    : ["https://chatgpt.com/connector/oauth/"];
  const prefixEntries = prefixes.map((prefix) => oauthPrefixEntry(prefix));
  const before = new Set(clientRegistrations.get(bootstrapClientId)?.redirectUris ?? []);
  mergeClientRegistration(bootstrapClientId, prefixEntries);
  const changed = prefixEntries.some((entry) => !before.has(entry));
  if (changed) {
    await persistOAuthClientRegistrations(config.dataDir);
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
  for (const [token, entry] of accessTokens) {
    if (entry.expiresAt < now) accessTokens.delete(token);
  }
  cleanupCommandJobs(now);
}, 60_000);
cleanupTimer.unref?.();

function isTerminalJobStatus(status: CommandJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "cancelled";
}

function isActiveJobStatus(status: CommandJobStatus): boolean {
  return !isTerminalJobStatus(status);
}

function notifyCommandJobWaiters(job: CommandJob): void {
  const waiters = [...job.waiters];
  job.waiters.clear();
  for (const waiter of waiters) waiter();
}

function cleanupCommandJobs(now = Date.now()): void {
  for (const [jobId, job] of commandJobs) {
    if (isTerminalJobStatus(job.status) && (job.completedAt ?? job.createdAt) + COMMAND_JOB_RETENTION_MS < now) {
      commandJobs.delete(jobId);
    }
  }
}

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
  if (!value) return Infinity;
  if (value.toLowerCase() === "none") return Infinity;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return Infinity;
  return parsed <= 0 ? Infinity : parsed;
}

function parseOutputMaxChars(value: string | undefined): number {
  if (!value) return DEFAULT_EXEC_OUTPUT_MAX_CHARS;
  const normalized = value.toLowerCase();
  if (normalized === "none" || normalized === "off" || normalized === "0") return Infinity;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(500, "SSH_MCP_EXEC_OUTPUT_MAX_CHARS must be a positive integer, or none", "CONFIG_INVALID");
  }
  return parsed;
}

function parseDurationMs(value: string | undefined, fallback: number | undefined, name: string): number | undefined {
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (normalized === "none" || normalized === "off" || normalized === "0") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(500, `${name} must be a positive integer number of milliseconds, or none`, "CONFIG_INVALID");
  }
  return parsed;
}

function parseDurationArg(value: unknown, fallback: number | undefined, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "none" || normalized === "off" || normalized === "0") return undefined;
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  throw new AppError(400, `${name} must be a positive integer number of milliseconds, or none`, "INVALID_PARAMS");
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

function parseProfilesJson(raw: string, sourceName: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new AppError(500, `${sourceName} must contain valid JSON: ${message}`, "CONFIG_INVALID");
  }
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(500, `${name} must be a JSON object`, "CONFIG_INVALID");
  }
  return value as Record<string, unknown>;
}

function profileString(raw: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function profileRawString(raw: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function profileBoolean(raw: Record<string, unknown>, names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value.trim()) return isEnabled(value.trim(), fallback);
  }
  return fallback;
}

function profilePort(raw: Record<string, unknown>, profileId: string): number {
  const value = raw.port;
  if (value === undefined || value === null || value === "") return 22;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(500, `SSH profile ${profileId} port must be a positive integer`, "CONFIG_INVALID");
  }
  return Math.floor(parsed);
}

function loadRawProfilesConfig(): unknown | undefined {
  const inlineJson = getRawEnv("SSH_MCP_PROFILES_JSON");
  if (inlineJson) return parseProfilesJson(inlineJson, "SSH_MCP_PROFILES_JSON");

  const filePath = getEnv("SSH_MCP_PROFILES_FILE");
  if (!filePath) return undefined;
  try {
    return parseProfilesJson(readFileSync(filePath, "utf8"), "SSH_MCP_PROFILES_FILE");
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : "read failed";
    throw new AppError(500, `Failed to read SSH_MCP_PROFILES_FILE: ${message}`, "CONFIG_INVALID");
  }
}

function rawProfileEntries(raw: unknown): { entries: Array<[string | undefined, Record<string, unknown>]>; defaultProfileId?: string } {
  if (Array.isArray(raw)) {
    return { entries: raw.map((item) => [undefined, objectRecord(item, "SSH profile")]) };
  }

  const config = objectRecord(raw, "SSH profile config");
  const defaultProfileId = profileString(config, ["default", "default_profile_id", "defaultProfileId"]);
  const profiles = config.profiles;
  if (Array.isArray(profiles)) {
    return { entries: profiles.map((item) => [undefined, objectRecord(item, "SSH profile")]), defaultProfileId };
  }
  if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
    return {
      entries: Object.entries(profiles as Record<string, unknown>).map(([id, item]) => [id, objectRecord(item, `SSH profile ${id}`)]),
      defaultProfileId,
    };
  }

  throw new AppError(500, "SSH profile config must be an array or an object with a profiles array/object", "CONFIG_INVALID");
}

function parseSshProfiles(): { profiles: SshProfileConfig[]; defaultSshProfileId?: string } {
  const raw = loadRawProfilesConfig();
  if (raw === undefined) return { profiles: [] };

  const { entries, defaultProfileId: configuredDefault } = rawProfileEntries(raw);
  const profiles: SshProfileConfig[] = [];
  const seen = new Set<string>();
  const markedDefaults: string[] = [];

  for (const [entryId, profileRaw] of entries) {
    const id = profileString(profileRaw, ["id"]) ?? entryId?.trim();
    if (!id) throw new AppError(500, "Each SSH profile must have a non-empty id", "CONFIG_INVALID");
    if (seen.has(id)) throw new AppError(500, `Duplicate SSH profile id: ${id}`, "CONFIG_INVALID");
    seen.add(id);

    const host = profileString(profileRaw, ["host"]);
    const username = profileString(profileRaw, ["username", "user"]);
    if (!host || !username) {
      throw new AppError(500, `SSH profile ${id} must include host and user/username`, "CONFIG_INVALID");
    }

    const isDefault = profileBoolean(profileRaw, ["default"], false);
    if (isDefault) markedDefaults.push(id);
    profiles.push({
      id,
      label: profileString(profileRaw, ["label", "name"]) ?? id,
      host,
      port: profilePort(profileRaw, id),
      username,
      password: profileRawString(profileRaw, ["password"]),
      privateKey: profileRawString(profileRaw, ["private_key", "privateKey"])?.replace(/\\n/g, "\n"),
      privateKeyPath: profileString(profileRaw, ["private_key_path", "privateKeyPath", "key"]),
      sudoEnabled: profileBoolean(profileRaw, ["sudo_enabled", "sudoEnabled"], false),
      default: false,
    });
  }

  if (markedDefaults.length > 1) {
    throw new AppError(500, `Only one SSH profile can be marked default: ${markedDefaults.join(", ")}`, "CONFIG_INVALID");
  }

  const envDefault = getEnv("SSH_MCP_DEFAULT_PROFILE", "SSH_MCP_DEFAULT_PROFILE_ID");
  const defaultSshProfileId = envDefault ?? configuredDefault ?? markedDefaults[0];
  if (defaultSshProfileId && !seen.has(defaultSshProfileId)) {
    throw new AppError(500, `Default SSH profile does not exist: ${defaultSshProfileId}`, "CONFIG_INVALID");
  }
  for (const profile of profiles) profile.default = profile.id === defaultSshProfileId;

  return { profiles, defaultSshProfileId };
}

function isLegacySshTargetConfigured(): boolean {
  return Boolean(getEnv("SSH_MCP_HOST", "SSH_HOST") && getEnv("SSH_MCP_USER", "SSH_USER"));
}

function publicSshProfiles(config: RuntimeConfig): PublicSshProfile[] {
  if (config.sshProfiles.length > 0) {
    return config.sshProfiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      sudo_enabled: !config.disableSudo && profile.sudoEnabled,
      default: profile.default,
    }));
  }

  if (!isLegacySshTargetConfigured()) return [];
  return [
    {
      id: LEGACY_TARGET_ID,
      label: "Default SSH target",
      sudo_enabled: !config.disableSudo,
      default: true,
    },
  ];
}

function loadRuntimeConfig(): RuntimeConfig {
  const oauthBaseUrl = getEnv("OAUTH_BASE_URL", "SSH_MCP_OAUTH_BASE_URL")?.replace(/\/+$/, "");
  const oauthLoginSecret = getRawEnv("OAUTH_LOGIN_SECRET", "SSH_MCP_OAUTH_LOGIN_SECRET");
  const sshProfileConfig = parseSshProfiles();

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
    execExpireTimeMs: parseDurationMs(
      getEnv("SSH_MCP_EXEC_EXPIRE_TIME_MS", "SSH_MCP_EXPIRE_TIME_MS", "EXEC_EXPIRE_TIME_MS"),
      DEFAULT_EXEC_EXPIRE_TIME_MS,
      "SSH_MCP_EXEC_EXPIRE_TIME_MS",
    ) ?? DEFAULT_EXEC_EXPIRE_TIME_MS,
    execKillTimeMs: parseDurationMs(
      getEnv("SSH_MCP_EXEC_KILL_TIME_MS", "SSH_MCP_KILL_TIME_MS", "EXEC_KILL_TIME_MS"),
      undefined,
      "SSH_MCP_EXEC_KILL_TIME_MS",
    ),
    execOutputMaxChars: parseOutputMaxChars(
      getEnv("SSH_MCP_EXEC_OUTPUT_MAX_CHARS", "SSH_MCP_OUTPUT_MAX_CHARS", "EXEC_OUTPUT_MAX_CHARS"),
    ),
    sshProfiles: sshProfileConfig.profiles,
    defaultSshProfileId: sshProfileConfig.defaultSshProfileId,
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

function isLocalHost(host: string): boolean {
  const hostname = host.split(":")[0]?.replace(/^\[|\]$/g, "").toLowerCase() ?? "";
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function resolvePublicProto(req: IncomingMessage, host: string): string {
  const forwarded = getHeader(req.headers, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;

  const cfVisitor = getHeader(req.headers, "cf-visitor");
  if (cfVisitor?.includes('"scheme":"https"')) return "https";

  const hostname = host.split(":")[0] ?? "";
  if (!isLocalHost(host) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return "https";
  }
  return "http";
}

function externalBaseUrl(req: IncomingMessage, config: RuntimeConfig): string {
  const forwardedHost = getHeader(req.headers, "x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || getHeader(req.headers, "host");
  if (host && !isLocalHost(host)) {
    const proto = resolvePublicProto(req, host);
    return `${proto}://${host}`.replace(/\/+$/, "");
  }
  if (config.oauthBaseUrl) return config.oauthBaseUrl;
  const fallbackHost = host ?? "127.0.0.1";
  const proto = getHeader(req.headers, "x-forwarded-proto") ?? "http";
  return `${proto}://${fallbackHost}`.replace(/\/+$/, "");
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

function formatSshExitStatus(code: number | null, signal: string | null): string {
  if (signal) return code === null ? `signal ${signal}` : `code ${code}, signal ${signal}`;
  return code === null ? "unknown exit status" : `code ${code}`;
}

function outputLimitPayload(maxChars: number): number | "none" {
  return Number.isFinite(maxChars) ? maxChars : "none";
}

function appendCommandJobOutput(job: CommandJob, streamName: "stdout" | "stderr", data: Buffer): void {
  const chunk = data.toString();
  const maxChars = job.outputMaxChars;

  if (streamName === "stdout") {
    job.stdoutChars += chunk.length;
    if (Number.isFinite(maxChars)) {
      const combined = job.stdout + chunk;
      if (combined.length > maxChars) {
        job.stdout = combined.slice(combined.length - maxChars);
        job.stdoutTruncated = true;
      } else {
        job.stdout = combined;
      }
      return;
    }
    job.stdout += chunk;
    return;
  }

  job.stderrChars += chunk.length;
  if (Number.isFinite(maxChars)) {
    const combined = job.stderr + chunk;
    if (combined.length > maxChars) {
      job.stderr = combined.slice(combined.length - maxChars);
      job.stderrTruncated = true;
    } else {
      job.stderr = combined;
    }
    return;
  }
  job.stderr += chunk;
}

function commandJobPayload(job: CommandJob): JsonObject {
  const now = Date.now();
  const completedAt = job.completedAt;
  const payload: JsonObject = {
    status: job.status,
    tool: job.tool,
    target_id: job.targetId,
    target_label: job.targetLabel,
    job_id: job.id,
    stdout: job.stdout,
    stderr: job.stderr,
    stdout_truncated: job.stdoutTruncated,
    stderr_truncated: job.stderrTruncated,
    stdout_total_chars: job.stdoutChars,
    stderr_total_chars: job.stderrChars,
    output_max_chars: outputLimitPayload(job.outputMaxChars),
    command_length: job.commandLength,
    elapsed_ms: (completedAt ?? now) - job.createdAt,
    created_at: new Date(job.createdAt).toISOString(),
    expire_time_ms: job.expireTimeMs,
    kill_time_ms: job.killTimeMs ?? "none",
  };
  if (job.startedAt) payload.started_at = new Date(job.startedAt).toISOString();
  if (job.stopRequestedAt) payload.stop_requested_at = new Date(job.stopRequestedAt).toISOString();
  if (job.stopRequestedStatus) payload.stop_requested_status = job.stopRequestedStatus;
  if (job.stopSignalSent !== undefined) payload.stop_signal_sent = job.stopSignalSent;
  if (job.stopError) payload.stop_error = job.stopError;
  if (completedAt) payload.completed_at = new Date(completedAt).toISOString();
  if (job.exitCode !== undefined) payload.exit_code = job.exitCode;
  if (job.signal !== undefined) payload.signal = job.signal;
  if (job.error) payload.error = job.error;
  if (isActiveJobStatus(job.status)) {
    payload.next_action = `Command is still running. Call exec-status with job_id ${job.id} to fetch progress.`;
    if (job.status === "cancelling" || job.status === "kill_requested") {
      payload.next_action = `Stop requested but not confirmed yet. Call exec-status with job_id ${job.id} to confirm the final state.`;
    }
  }
  return payload;
}

function finishCommandJob(job: CommandJob, updates: Partial<CommandJob>): void {
  if (isTerminalJobStatus(job.status)) return;
  Object.assign(job, updates, { completedAt: Date.now() });
  if (job.killTimer) clearTimeout(job.killTimer);
  job.killTimer = undefined;
  try { job.stream?.removeAllListeners(); } catch { /* ignore */ }
  try { job.conn?.end(); } catch { /* ignore */ }
  job.stream = undefined;
  job.conn = undefined;
  notifyCommandJobWaiters(job);
}

function failCommandJob(job: CommandJob, error: string): void {
  if (job.stopRequestedStatus) {
    finishCommandJob(job, { status: job.stopRequestedStatus, error: job.stopReason ?? error });
    return;
  }
  finishCommandJob(job, { status: "failed", error });
}

function finalizeStoppedCommandJob(job: CommandJob): void {
  if (!job.stopRequestedStatus) return;
  finishCommandJob(job, { status: job.stopRequestedStatus, error: job.stopReason });
}

function stopRequestedRuntimeStatus(status: CommandJobStopStatus): CommandJobStatus {
  return status === "killed" ? "kill_requested" : "cancelling";
}

function requestStopCommandJob(job: CommandJob, status: CommandJobStopStatus, error: string): boolean {
  if (isTerminalJobStatus(job.status)) return false;
  job.status = stopRequestedRuntimeStatus(status);
  job.stopRequestedStatus = status;
  job.stopRequestedAt ??= Date.now();
  job.stopReason = error;

  let signalSent = false;
  let stopError: string | undefined;
  try {
    (job.stream as (ClientChannel & { signal?: (signalName: string) => void }) | undefined)?.signal?.("KILL");
    signalSent = Boolean(job.stream);
  } catch (err) {
    stopError = err instanceof Error ? err.message : "Failed to send SSH kill signal";
  }
  try { job.stream?.close(); } catch (err) {
    stopError = err instanceof Error ? err.message : "Failed to close SSH channel";
  }
  if (!job.stream) {
    try { job.conn?.end(); } catch (err) {
      stopError = err instanceof Error ? err.message : "Failed to close SSH connection";
    }
  }

  job.stopSignalSent = signalSent;
  if (stopError) job.stopError = stopError;
  notifyCommandJobWaiters(job);
  return true;
}

function startSshCommandJob(
  tool: CommandTool,
  target: ResolvedSshTarget,
  sshConfig: SSHConfig,
  remoteCommand: string,
  commandLength: number,
  expireTimeMs: number,
  outputMaxChars: number,
  killTimeMs?: number,
): CommandJob {
  const job: CommandJob = {
    id: `job-${randomToken(12)}`,
    tool,
    targetId: target.id,
    targetLabel: target.label,
    commandLength,
    status: "running",
    createdAt: Date.now(),
    expireTimeMs,
    killTimeMs,
    outputMaxChars,
    stdout: "",
    stderr: "",
    stdoutChars: 0,
    stderrChars: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    waiters: new Set(),
  };
  commandJobs.set(job.id, job);

  const conn = new Client();
  job.conn = conn;

  if (killTimeMs) {
    job.killTimer = setTimeout(() => {
      requestStopCommandJob(job, "killed", `Command exceeded kill_time_ms (${killTimeMs}ms)`);
    }, killTimeMs);
    job.killTimer.unref?.();
  }

  conn.on("ready", () => {
    job.startedAt = Date.now();
    conn.exec(remoteCommand, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        failCommandJob(job, `SSH exec error: ${err.message}`);
        return;
      }

      job.stream = stream;
      stream.on("data", (data: Buffer) => {
        appendCommandJobOutput(job, "stdout", data);
      });
      stream.stderr.on("data", (data: Buffer) => {
        appendCommandJobOutput(job, "stderr", data);
      });
      stream.on("close", (code: number | null, signal: string | null) => {
        if (isTerminalJobStatus(job.status)) return;
        job.exitCode = code;
        job.signal = signal;
        if (job.stopRequestedStatus) {
          finalizeStoppedCommandJob(job);
          return;
        }
        if (code === 0 && !signal) {
          finishCommandJob(job, { status: "completed" });
        } else {
          failCommandJob(job, `Error (${formatSshExitStatus(code, signal)}):\n${job.stderr || job.stdout}`);
        }
      });
    });
  });

  conn.on("error", (err: Error) => {
    failCommandJob(job, `SSH connection error: ${err.message}`);
  });
  conn.on("close", () => {
    if (isTerminalJobStatus(job.status)) return;
    if (job.stopRequestedStatus) {
      finalizeStoppedCommandJob(job);
      return;
    }
    if (job.status === "running" && !job.stream) {
      failCommandJob(job, "SSH connection closed before the command started");
    }
  });
  conn.connect(sshConfig);
  return job;
}

function waitForCommandJob(job: CommandJob, expireTimeMs: number): Promise<CommandJob> {
  if (isTerminalJobStatus(job.status)) return Promise.resolve(job);
  return new Promise((resolve) => {
    const onDone = () => {
      clearTimeout(timeout);
      resolve(job);
    };
    const timeout = setTimeout(() => {
      job.waiters.delete(onDone);
      resolve(job);
    }, expireTimeMs);
    timeout.unref?.();
    job.waiters.add(onDone);
  });
}

function resolveSshTarget(args: JsonObject, config: RuntimeConfig): ResolvedSshTarget {
  const requestedTargetId = optionalString(args.target_id);

  if (config.sshProfiles.length > 0) {
    const targetId = requestedTargetId ?? config.defaultSshProfileId;
    if (!targetId) {
      throw new AppError(400, "target_id is required because no default SSH profile is configured", "TARGET_REQUIRED");
    }
    const profile = config.sshProfiles.find((candidate) => candidate.id === targetId);
    if (!profile) throw new AppError(400, `Unknown SSH target_id: ${targetId}`, "TARGET_NOT_FOUND");
    return {
      id: profile.id,
      label: profile.label,
      sudoEnabled: profile.sudoEnabled,
      profile,
    };
  }

  if (requestedTargetId && requestedTargetId !== LEGACY_TARGET_ID) {
    throw new AppError(400, `Unknown SSH target_id: ${requestedTargetId}`, "TARGET_NOT_FOUND");
  }
  return {
    id: LEGACY_TARGET_ID,
    label: "Default SSH target",
    sudoEnabled: true,
  };
}

async function loadProfileSshConfig(profile: SshProfileConfig): Promise<SSHConfig> {
  const config: SSHConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };
  if (profile.password) {
    config.password = profile.password;
  } else if (profile.privateKey) {
    config.privateKey = profile.privateKey;
  } else if (profile.privateKeyPath) {
    config.privateKey = await readFile(profile.privateKeyPath, "utf8");
  }
  return config;
}

async function loadSshConfig(target: ResolvedSshTarget): Promise<SSHConfig> {
  if (target.profile) return loadProfileSshConfig(target.profile);

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

async function runSshTool(name: "exec" | "sudo-exec", args: JsonObject, config: RuntimeConfig, target: ResolvedSshTarget): Promise<JsonObject> {
  const command = sanitizeCommand(requireString(args.command, "command"), config.maxChars);
  const description = optionalString(args.description);
  const commandWithDescription = appendDescription(command, description);
  const expireTimeMs = parseDurationArg(args.expire_time_ms, config.execExpireTimeMs, "expire_time_ms") ?? config.execExpireTimeMs;
  const killTimeMs = parseDurationArg(args.kill_time_ms, config.execKillTimeMs, "kill_time_ms");

  let remoteCommand = commandWithDescription;
  if (name === "sudo-exec") {
    if (config.disableSudo) {
      throw new AppError(403, "sudo-exec is disabled on this deployment", "SUDO_DISABLED");
    }
    if (!target.sudoEnabled) {
      throw new AppError(403, `sudo-exec is disabled for SSH target ${target.id}`, "SUDO_DISABLED");
    }
    const quotedCommand = shellSingleQuote(commandWithDescription);
    if (config.sudoPassword) {
      remoteCommand = `printf '%s\\n' '${shellSingleQuote(config.sudoPassword)}' | sudo -p "" -S sh -c '${quotedCommand}'`;
    } else {
      remoteCommand = `sudo -n sh -c '${quotedCommand}'`;
    }
  }

  const sshConfig = await loadSshConfig(target);
  const job = startSshCommandJob(
    name,
    target,
    sshConfig,
    remoteCommand,
    command.length,
    expireTimeMs,
    config.execOutputMaxChars,
    killTimeMs,
  );
  await waitForCommandJob(job, expireTimeMs);
  return commandJobPayload(job);
}

function getCommandJob(args: JsonObject): CommandJob {
  const jobId = requireString(args.job_id, "job_id");
  const job = commandJobs.get(jobId);
  if (!job) throw new AppError(404, `Unknown command job: ${jobId}`, "JOB_NOT_FOUND");
  return job;
}

function runCommandStatusTool(args: JsonObject): JsonObject {
  cleanupCommandJobs();
  return commandJobPayload(getCommandJob(args));
}

function runCommandCancelTool(args: JsonObject): JsonObject {
  const job = getCommandJob(args);
  requestStopCommandJob(job, "cancelled", "Command cancellation requested by exec-cancel");
  return commandJobPayload(job);
}

function listProfilesTool(config: RuntimeConfig): JsonObject {
  return { profiles: publicSshProfiles(config) };
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

function commandAuditArgs(args: JsonObject, target: ResolvedSshTarget): JsonObject {
  return {
    ...args,
    target_id: target.id,
    target_label: target.label,
  };
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
    default_output_max_chars: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }] },
    default_expire_time_ms: { type: "number" },
    default_kill_time_ms: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }] },
    active_background_jobs: { type: "number" },
    ssh_target_configured: { type: "boolean" },
    ssh_profiles_configured: { type: "boolean" },
    ssh_profile_count: { type: "number" },
    default_ssh_profile_id: { anyOf: [{ type: "string" }, { type: "null" }] },
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
    "default_output_max_chars",
    "default_expire_time_ms",
    "default_kill_time_ms",
    "active_background_jobs",
    "ssh_target_configured",
    "ssh_profiles_configured",
    "ssh_profile_count",
    "default_ssh_profile_id",
  ],
  additionalProperties: false,
};

const LIST_PROFILES_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    profiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          sudo_enabled: { type: "boolean" },
          default: { type: "boolean" },
        },
        required: ["id", "label", "sudo_enabled", "default"],
        additionalProperties: false,
      },
    },
  },
  required: ["profiles"],
  additionalProperties: false,
};

const COMMAND_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["running", "cancelling", "kill_requested", "completed", "failed", "killed", "cancelled"] },
    tool: { type: "string", enum: ["exec", "sudo-exec"] },
    target_id: { type: "string" },
    target_label: { type: "string" },
    job_id: { type: "string" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    stdout_truncated: { type: "boolean" },
    stderr_truncated: { type: "boolean" },
    stdout_total_chars: { type: "number" },
    stderr_total_chars: { type: "number" },
    output_max_chars: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }] },
    command_length: { type: "number" },
    elapsed_ms: { type: "number" },
    created_at: { type: "string" },
    started_at: { type: "string" },
    stop_requested_at: { type: "string" },
    stop_requested_status: { type: "string", enum: ["killed", "cancelled"] },
    stop_signal_sent: { type: "boolean" },
    stop_error: { type: "string" },
    completed_at: { type: "string" },
    expire_time_ms: { type: "number" },
    kill_time_ms: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }] },
    exit_code: { anyOf: [{ type: "number" }, { type: "null" }] },
    signal: { anyOf: [{ type: "string" }, { type: "null" }] },
    error: { type: "string" },
    code: { type: "string" },
    next_action: { type: "string" },
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

const TARGET_ID_INPUT_SCHEMA: JsonObject = {
  type: "string",
  description:
    "Optional server-side SSH profile ID. Required when no default profile is configured. Do not pass hostnames or credential material here.",
};

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
        name: "list-profiles",
        description:
          "List non-sensitive server-side SSH profile metadata: profile IDs, labels, default marker, and sudo availability. Does not return hostnames, usernames, credential paths, passwords, private keys, or other connection details.",
        inputSchema: schema({}),
        outputSchema: LIST_PROFILES_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true },
      },
      protectedSchemes,
    ),
    withSecurity(
      {
        name: "exec",
        description:
          "Execute a shell command on a server-side configured SSH profile. Use list-profiles to see available profile IDs and labels. Pass target_id to select a profile, or omit it only when the deployment has a default profile. If no default profile is configured, target_id is required. Do not pass hostnames, passwords, private keys, or credential material in tool arguments. If the command exceeds expire_time_ms, the tool returns a running job_id while the command continues in the background. Use exec-status to poll it. Ask for confirmation before running destructive commands.",
        inputSchema: schema(
          {
            target_id: TARGET_ID_INPUT_SCHEMA,
            command: { type: "string", minLength: 1, description: "Shell command to execute on the configured SSH target." },
            description: { type: "string", description: "Optional legacy command comment appended on the remote shell." },
            expire_time_ms: { type: "number", description: "Optional time to wait before returning a running job_id. Defaults to deployment configuration." },
            kill_time_ms: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }], description: "Optional hard deadline for killing the background command. Defaults to deployment configuration; none disables the hard deadline." },
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
    withSecurity(
      {
        name: "exec-status",
        description: "Fetch stdout, stderr, exit status, and progress for a background exec or sudo-exec job_id.",
        inputSchema: schema(
          { job_id: { type: "string", minLength: 1, description: "Background command job_id returned by exec or sudo-exec." } },
          ["job_id"],
        ),
        outputSchema: COMMAND_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true },
      },
      protectedSchemes,
    ),
    withSecurity(
      {
        name: "exec-cancel",
        description: "Request cancellation for a running background exec or sudo-exec job_id by sending a kill signal to the SSH channel; poll exec-status until the final cancelled/killed status is confirmed.",
        inputSchema: schema(
          { job_id: { type: "string", minLength: 1, description: "Background command job_id returned by exec or sudo-exec." } },
          ["job_id"],
        ),
        outputSchema: COMMAND_OUTPUT_SCHEMA,
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
            "Execute a bounded shell command through sudo on a server-side configured SSH profile. Use list-profiles to see available profile IDs, labels, and sudo availability. Pass target_id to select a profile, or omit it only when the deployment has a default profile. The resolved profile must allow sudo and the global sudo kill switch must be enabled. Do not pass hostnames, passwords, private keys, or credential material in tool arguments. Ask for confirmation before running destructive commands.",
          inputSchema: schema(
            {
              target_id: TARGET_ID_INPUT_SCHEMA,
              command: { type: "string", minLength: 1, description: "Shell command to execute with sudo." },
              description: { type: "string", description: "Optional legacy command comment appended on the remote shell." },
              expire_time_ms: { type: "number", description: "Optional time to wait before returning a running job_id. Defaults to deployment configuration." },
              kill_time_ms: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }], description: "Optional hard deadline for killing the background command. Defaults to deployment configuration; none disables the hard deadline." },
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
  const profiles = publicSshProfiles(config);
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
    default_output_max_chars: outputLimitPayload(config.execOutputMaxChars),
    default_expire_time_ms: config.execExpireTimeMs,
    default_kill_time_ms: config.execKillTimeMs ?? "none",
    active_background_jobs: [...commandJobs.values()].filter((job) => isActiveJobStatus(job.status)).length,
    ssh_target_configured: profiles.length > 0,
    ssh_profiles_configured: config.sshProfiles.length > 0,
    ssh_profile_count: profiles.length,
    default_ssh_profile_id: config.sshProfiles.length > 0 ? config.defaultSshProfileId ?? null : (profiles[0]?.id ?? null),
  };
}

async function invokeTool(name: string, args: JsonObject, sessionId: string, config: RuntimeConfig): Promise<JsonObject> {
  if (name === "exec" || name === "sudo-exec") {
    const target = resolveSshTarget(args, config);
    await auditToolCall(name, commandAuditArgs(args, target), sessionId, config);
    return runSshTool(name, args, config, target);
  }
  await auditToolCall(name, args, sessionId, config);
  if (name === "health") return healthPayload(config);
  if (name === "list-profiles") return listProfilesTool(config);
  if (name === "exec-status") return runCommandStatusTool(args);
  if (name === "exec-cancel") return runCommandCancelTool(args);
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
  const registration = clientRegistrations.get(clientId);
  if (!registration) return false;
  return oauthMatchesRedirectUri(registration, redirectUri);
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
  mergeClientRegistration(clientId, parsed.redirectUris);
  const dataDir = getEnv("SSH_MCP_DATA_DIR", "DATA_DIR") ?? ".ssh-mcp-data";
  await persistOAuthClientRegistrations(dataDir);
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

function authorizeHelpHtml(baseUrl: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>SSH MCP OAuth</title>
<style>body{font-family:system-ui;max-width:560px;margin:72px auto;padding:0 20px;line-height:1.6;color:#202124}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
</head>
<body>
<h1>SSH MCP OAuth</h1>
<p>${message}</p>
<p>请通过 ChatGPT Connector 发起 OAuth 登录，不要直接在浏览器打开裸 <code>/authorize</code> 地址。</p>
<p>Connector URL：<code>${baseUrl}/mcp</code></p>
</body></html>`;
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
      sendHtml(
        res,
        200,
        authorizeHelpHtml(
          externalBaseUrl(req, config),
          "缺少 OAuth 参数或 redirect_uri 未注册。这通常表示你尚未从 ChatGPT 发起授权。",
        ),
      );
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
  await bootstrapOAuthClients(config);

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

export { loadRuntimeConfig, listTools, healthPayload, invokeTool };
