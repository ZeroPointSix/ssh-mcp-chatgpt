/**
 * Remote file tools for the long command optimization work (ZER-496).
 *
 * The connector used to have only `exec`. To put a file on a remote host the
 * caller had to put the full file body inside one shell command. This module
 * removes that need: the file body travels over the SSH channel stdin as
 * base64 and only the quoted path goes into the command line.
 */

import { createHash, randomUUID } from "node:crypto";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import type { SSHConfig } from "./index.js";

export type JsonObject = Record<string, unknown>;

export const FS_TOOL_NAMES = ["fs-read", "fs-write", "fs-edit", "run-script"] as const;
export type FsToolName = (typeof FS_TOOL_NAMES)[number];

export const DEFAULT_FS_MAX_BYTES = 8_000_000;
export const DEFAULT_FS_PREVIEW_MAX_CHARS = 400;
export const DEFAULT_FS_READ_MAX_CHARS = 200_000;
export const DEFAULT_FS_READ_MAX_LINES = 2_000;
export const DEFAULT_FS_TIMEOUT_MS = 60_000;
export const FS_CONTENT_SENTINEL = "---FS-CONTENT---";
export const FS_STAGING_DIR = "/tmp/.mcp/staging";
export const FS_SCRIPT_DIR = "/tmp/.mcp/scripts";

export class FsToolError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "FS_ERROR",
  ) {
    super(message);
    this.name = "FsToolError";
  }
}

export interface FsRuntimeConfig {
  enabled: boolean;
  allowedRoots: string[];
  maxBytes: number;
  previewMaxChars: number;
  readMaxChars: number;
  readMaxLines: number;
  syntaxCheckEnabled: boolean;
  timeoutMs: number;
}

export interface FsToolContext {
  targetId: string;
  targetLabel: string;
}

export type FsWriteMode = "create" | "overwrite" | "append";
export type FsEncoding = "utf8" | "base64";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function parseFsFlag(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function parseFsLimit(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (normalized === "none" || normalized === "off") return Infinity;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new FsToolError(500, `${name} must be a positive integer, or none`, "FS_CONFIG_INVALID");
  }
  return parsed;
}

export function parseBoundedFsLimit(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseFsLimit(value, fallback, name);
  if (!Number.isFinite(parsed)) {
    throw new FsToolError(500, `${name} must have a finite positive limit`, "FS_CONFIG_INVALID");
  }
  return parsed;
}

export function parseAllowedRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,:]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeRemotePath(item));
}

export function loadFsRuntimeConfig(env: NodeJS.ProcessEnv = process.env): FsRuntimeConfig {
  return {
    enabled: parseFsFlag(envValue(env, "SSH_MCP_FS_TOOLS_ENABLED"), false),
    allowedRoots: parseAllowedRoots(envValue(env, "SSH_MCP_FS_ALLOWED_ROOTS")),
    maxBytes: parseFsLimit(envValue(env, "SSH_MCP_FS_MAX_BYTES"), DEFAULT_FS_MAX_BYTES, "SSH_MCP_FS_MAX_BYTES"),
    previewMaxChars: parseFsLimit(
      envValue(env, "SSH_MCP_FS_PREVIEW_MAX_CHARS"),
      DEFAULT_FS_PREVIEW_MAX_CHARS,
      "SSH_MCP_FS_PREVIEW_MAX_CHARS",
    ),
    readMaxChars: parseBoundedFsLimit(
      envValue(env, "SSH_MCP_FS_READ_MAX_CHARS"),
      DEFAULT_FS_READ_MAX_CHARS,
      "SSH_MCP_FS_READ_MAX_CHARS",
    ),
    readMaxLines: parseBoundedFsLimit(
      envValue(env, "SSH_MCP_FS_READ_MAX_LINES"),
      DEFAULT_FS_READ_MAX_LINES,
      "SSH_MCP_FS_READ_MAX_LINES",
    ),
    syntaxCheckEnabled: parseFsFlag(envValue(env, "SSH_MCP_FS_SYNTAX_CHECK"), true),
    timeoutMs: parseFsLimit(envValue(env, "SSH_MCP_FS_TIMEOUT_MS"), DEFAULT_FS_TIMEOUT_MS, "SSH_MCP_FS_TIMEOUT_MS"),
  };
}

/* ------------------------------------------------------------------ */
/* Path and payload guards                                             */
/* ------------------------------------------------------------------ */

export function normalizeRemotePath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new FsToolError(400, "path must be a non-empty string", "FS_PATH_INVALID");
  }
  const path = rawPath.trim();
  if (!path.startsWith("/")) {
    throw new FsToolError(400, `path must be absolute: ${path}`, "FS_PATH_INVALID");
  }
  if (path.includes("\0")) {
    throw new FsToolError(400, "path must not contain NUL characters", "FS_PATH_INVALID");
  }
  if (/[\n\r]/.test(path)) {
    throw new FsToolError(400, "path must not contain newline characters", "FS_PATH_INVALID");
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    throw new FsToolError(400, `path must not contain .. segments: ${path}`, "FS_PATH_INVALID");
  }
  const kept = segments.filter((segment) => segment.length > 0 && segment !== ".");
  if (kept.length === 0) {
    throw new FsToolError(400, "path must not be the root directory", "FS_PATH_INVALID");
  }
  return `/${kept.join("/")}`;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  if (root === "/") return true;
  return path === root || path.startsWith(`${root}/`);
}

export function assertPathAllowed(path: string, allowedRoots: string[]): void {
  if (allowedRoots.length === 0) {
    throw new FsToolError(403, "No allowed roots are configured for file tools", "FS_PATH_FORBIDDEN");
  }
  if (allowedRoots.some((root) => isPathInsideRoot(path, root))) return;
  throw new FsToolError(403, `path is outside the allowed roots: ${path}`, "FS_PATH_FORBIDDEN");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function parseWriteMode(value: unknown): FsWriteMode {
  if (value === undefined || value === null || value === "") return "overwrite";
  if (value === "create" || value === "overwrite" || value === "append") return value;
  throw new FsToolError(400, "mode must be create, overwrite, or append", "FS_MODE_INVALID");
}

export function parseEncoding(value: unknown): FsEncoding {
  if (value === undefined || value === null || value === "") return "utf8";
  if (value === "utf8" || value === "base64") return value;
  throw new FsToolError(400, "encoding must be utf8 or base64", "FS_ENCODING_INVALID");
}

export function parseFileMode(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const mode = String(value).trim();
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new FsToolError(400, "file_mode must be an octal value such as 644 or 0755", "FS_FILE_MODE_INVALID");
  }
  return mode;
}

export function parseSha256(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const digest = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new FsToolError(400, `${name} must be a 64 character hex sha256 value`, "FS_SHA256_INVALID");
  }
  return digest;
}

export function decodeContent(content: unknown, encoding: FsEncoding): Buffer {
  if (typeof content !== "string") {
    throw new FsToolError(400, "content must be a string", "FS_CONTENT_INVALID");
  }
  if (encoding === "utf8") return Buffer.from(content, "utf8");

  const compact = content.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new FsToolError(400, "content is not valid base64", "FS_CONTENT_INVALID");
  }
  return Buffer.from(compact, "base64");
}

export function buildPreview(text: string, maxChars: number): { preview: string; preview_truncated: boolean } {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) {
    return { preview: text, preview_truncated: false };
  }
  const head = Math.max(1, Math.ceil(maxChars * 0.6));
  const tail = Math.max(1, maxChars - head);
  return {
    preview: `${text.slice(0, head)}\n...\n${text.slice(text.length - tail)}`,
    preview_truncated: true,
  };
}

export function parseOwner(value: unknown): { user: string; group: string } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(value)) {
    throw new FsToolError(400, "owner must use the user:group format", "FS_OWNER_INVALID");
  }
  const [user, group] = value.split(":", 2);
  return { user, group };
}

export function decodeFileContent(args: JsonObject): { payload: Buffer; source: string; binary: boolean } {
  const hasText = typeof args.content === "string";
  const hasBase64 = typeof args.content_base64 === "string";
  if (hasText === hasBase64) {
    throw new FsToolError(400, "Provide exactly one of content or content_base64", "FS_CONTENT_INVALID");
  }
  if (hasBase64) {
    const payload = decodeContent(args.content_base64, "base64");
    return { payload, source: payload.toString("utf8"), binary: true };
  }
  const normalizeNewlines = args.normalize_newlines === undefined ? true : Boolean(args.normalize_newlines);
  const source = normalizeNewlines ? String(args.content).replace(/\r\n?/g, "\n") : String(args.content);
  return { payload: Buffer.from(source, "utf8"), source, binary: false };
}

/* ------------------------------------------------------------------ */
/* Remote script builders                                              */
/* ------------------------------------------------------------------ */

const DIGEST_FUNCTION = [
  "fs_digest() {",
  '  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d" " -f1;',
  '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d" " -f1;',
  '  else openssl dgst -sha256 "$1" | awk \'{print $NF}\'; fi',
  "}",
].join("\n");

export function buildResolvePathScript(
  path: string,
  allowedRoots: string[],
  allowMissing: boolean,
  elevate = false,
): string {
  assertPathAllowed(path, allowedRoots);
  const roots = allowedRoots.map((root) => shellQuote(root)).join(" ");
  const lines = [
    "set -e",
    `target=${shellQuote(path)}`,
    'if [ -e "$target" ] || [ -L "$target" ]; then',
    '  canonical=$(realpath "$target")',
    allowMissing
      ? 'else canonical=$(realpath -m "$target")'
      : 'else parent=$(dirname "$target"); [ -d "$parent" ] || exit 44; canonical="$(realpath "$parent")/$(basename "$target")"',
    "fi",
    "allowed=0",
    `for root in ${roots}; do`,
    '  root_real=$(realpath -m "$root")',
    '  if [ "$root_real" = "/" ]; then allowed=1; break; fi',
    '  case "$canonical" in "$root_real"|"$root_real"/*) allowed=1; break ;; esac',
    "done",
    'if [ "$allowed" -ne 1 ]; then echo "canonical path is outside the allowed roots" >&2; exit 77; fi',
    "printf 'FS_PATH %s\\n' \"$canonical\"",
  ];
  const script = lines.join("\n");
  return elevate ? `sudo -n sh -c ${shellQuote(script)}` : script;
}

export function parseResolvedPath(stdout: string): string {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("FS_PATH "));
  if (!line) throw new FsToolError(502, "Remote path resolution did not report a path", "FS_PATH_RESULT_MISSING");
  return normalizeRemotePath(line.slice("FS_PATH ".length));
}

/** Returns a shell statement that validates the uploaded temporary file. */
export function syntaxCheckStatement(path: string, fileVariable = "$tmp"): string | undefined {
  const quotedVariable = `"${fileVariable}"`;
  const lower = path.toLowerCase();
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) {
    return `if command -v bash >/dev/null 2>&1; then bash -n ${quotedVariable}; else sh -n ${quotedVariable}; fi`;
  }
  if (lower.endsWith(".py")) {
    return `if command -v python3 >/dev/null 2>&1; then python3 -c "import ast,sys;ast.parse(open(sys.argv[1]).read())" ${quotedVariable}; fi`;
  }
  if (lower.endsWith(".json")) {
    return `if command -v python3 >/dev/null 2>&1; then python3 -c "import json,sys;json.load(open(sys.argv[1]))" ${quotedVariable}; fi`;
  }
  return undefined;
}

export interface WriteScriptOptions {
  path: string;
  stagingPath: string;
  createDirs: boolean;
  fileMode: string;
  owner?: { user: string; group: string };
  expectedSha?: string;
  payloadSha: string;
  syntaxCheck?: string;
  backupSuffix?: string;
  verify: boolean;
  elevate: boolean;
  preserveMetadata?: boolean;
}

export function buildWriteScript(options: WriteScriptOptions): string {
  const lines: string[] = [
    "set -e",
    `target=${shellQuote(options.path)}`,
    `staging=${shellQuote(options.stagingPath)}`,
    'install_tmp="$target.ssh-mcp-install.$$"',
    'trap \'rm -f "$staging" "$install_tmp"\' EXIT',
    DIGEST_FUNCTION,
    `stage_digest=$(fs_digest "$staging")`,
    `if [ "$stage_digest" != ${shellQuote(options.payloadSha)} ]; then echo "staging sha256 mismatch" >&2; exit 46; fi`,
    'parent=$(dirname "$target")',
  ];

  if (options.createDirs) {
    lines.push('if [ ! -d "$parent" ]; then mkdir -p "$parent"; printf \'FS_CREATED_DIR %s\\n\' "$parent"; fi');
  } else {
    lines.push('if [ ! -d "$parent" ]; then echo "parent directory does not exist: $parent" >&2; exit 44; fi');
  }

  lines.push('current_sha="missing"');
  lines.push(`target_mode=${shellQuote(options.fileMode)}`);
  if (options.preserveMetadata) {
    lines.push('if [ -f "$target" ]; then current_sha=$(fs_digest "$target"); target_mode=$(stat -c %a "$target"); target_user=$(stat -c %u "$target"); target_group=$(stat -c %g "$target"); fi');
  } else {
    lines.push('if [ -f "$target" ]; then current_sha=$(fs_digest "$target"); fi');
  }
  if (options.expectedSha) {
    lines.push(
      `if [ "$current_sha" != ${shellQuote(options.expectedSha)} ]; then printf 'FS_CONFLICT %s\\n' "$current_sha" >&2; exit 42; fi`,
    );
  }
  lines.push(
    `if [ "$current_sha" = ${shellQuote(options.payloadSha)} ]; then size=$(wc -c < "$target" | tr -d " "); printf 'FS_UNCHANGED %s %s\\n' "$size" "$current_sha"; exit 0; fi`,
  );

  if (options.syntaxCheck) {
    lines.push(options.syntaxCheck);
  }
  if (options.backupSuffix) {
    lines.push(`if [ -e "$target" ]; then cp -a "$target" "$target${options.backupSuffix}"; fi`);
  }

  const ownerFlags = options.owner ? ` -o ${shellQuote(options.owner.user)} -g ${shellQuote(options.owner.group)}` : "";
  if (options.preserveMetadata && options.elevate) {
    lines.push('install -m "$target_mode" -o "$target_user" -g "$target_group" "$staging" "$install_tmp"');
  } else if (options.preserveMetadata) {
    lines.push('install -m "$target_mode" "$staging" "$install_tmp"');
  } else {
    lines.push(`install -m ${options.fileMode}${ownerFlags} "$staging" "$install_tmp"`);
  }
  lines.push('mv -f "$install_tmp" "$target"');

  lines.push('size=$(wc -c < "$target" | tr -d " ")');
  lines.push('digest=$(fs_digest "$target")');
  if (options.verify) {
    lines.push(
      `if [ "$digest" != ${shellQuote(options.payloadSha)} ]; then echo "verification sha256 mismatch" >&2; exit 47; fi`,
    );
  }
  lines.push("printf 'FS_RESULT %s %s\\n' \"$size\" \"$digest\"");
  if (options.backupSuffix) lines.push(`if [ -f "$target${options.backupSuffix}" ]; then printf 'FS_BACKUP %s\\n' "$target${options.backupSuffix}"; fi`);
  const script = lines.join("\n");
  return options.elevate ? `sudo -n sh -c ${shellQuote(script)}` : script;
}

export function buildReadScript(
  path: string,
  offset = 1,
  limit = DEFAULT_FS_READ_MAX_LINES,
  maxChars = DEFAULT_FS_READ_MAX_CHARS,
  elevate = false,
): string {
  const outputCap = Math.max(1, Math.floor(Number.isFinite(maxChars) ? maxChars : DEFAULT_FS_READ_MAX_CHARS)) + 1;
  const lines: string[] = [
    "set -e",
    `target=${shellQuote(path)}`,
    'if [ ! -f "$target" ]; then echo "file not found: $target" >&2; exit 2; fi',
    DIGEST_FUNCTION,
    'size=$(wc -c < "$target" | tr -d " ")',
    'line_count=$(awk \'END { print NR }\' "$target")',
    'digest=$(fs_digest "$target")',
    "printf 'FS_RESULT %s %s %s\\n' \"$size\" \"$digest\" \"$line_count\"",
    `printf '%s\\n' ${shellQuote(FS_CONTENT_SENTINEL)}`,
  ];
  lines.push(
    `awk -v start=${offset} -v count=${limit} 'NR >= start { printf "%6d\\t%s\\n", NR, $0; emitted++; if (emitted >= count) exit }' "$target" | head -c ${outputCap}`,
  );
  const script = lines.join("\n");
  return elevate ? `sudo -n sh -c ${shellQuote(script)}` : script;
}

export function buildRawReadScript(path: string, maxBytes: number, elevate = false): string {
  const cap = Math.max(1, Math.floor(maxBytes));
  const lines = [
    "set -e",
    `target=${shellQuote(path)}`,
    'if [ ! -f "$target" ]; then echo "file not found: $target" >&2; exit 2; fi',
    DIGEST_FUNCTION,
    'size=$(wc -c < "$target" | tr -d " ")',
    `if [ "$size" -gt ${cap} ]; then echo "file is too large: $size bytes" >&2; exit 45; fi`,
    'digest=$(fs_digest "$target")',
    "printf 'FS_RESULT %s %s\\n' \"$size\" \"$digest\"",
    `printf '%s\\n' ${shellQuote(FS_CONTENT_SENTINEL)}`,
    `head -c ${cap + 1} "$target"`,
  ];
  const script = lines.join("\n");
  return elevate ? `sudo -n sh -c ${shellQuote(script)}` : script;
}

export type ScriptInterpreter = "bash" | "sh" | "python3" | "node";

export function parseInterpreter(value: unknown): ScriptInterpreter {
  if (value === undefined || value === null || value === "") return "bash";
  if (value === "bash" || value === "sh" || value === "python3" || value === "node") return value;
  throw new FsToolError(400, "interpreter must be bash, sh, python3, or node", "FS_INTERPRETER_INVALID");
}

export function buildRunCommand(
  path: string,
  interpreter: ScriptInterpreter = "bash",
  options: {
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    elevate?: boolean;
    cleanup?: boolean;
  } = {},
): string {
  const envPrefix = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const command = [envPrefix, interpreter, shellQuote(path), ...(options.args ?? []).map(shellQuote)].filter(Boolean).join(" ");
  const inDirectory = options.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;
  const elevated = options.elevate ? `sudo -n sh -c ${shellQuote(inDirectory)}` : inDirectory;
  if (!options.cleanup) return elevated;
  const cleanupScript = `${elevated}; status=$?; rm -f ${shellQuote(path)}; exit $status`;
  return `sh -c ${shellQuote(cleanupScript)}`;
}

/* ------------------------------------------------------------------ */
/* Remote command runner                                               */
/* ------------------------------------------------------------------ */

export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

async function writeStdin(stream: ClientChannel, payload: Buffer, chunkSize = 32 * 1024): Promise<void> {
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const chunk = payload.subarray(offset, offset + chunkSize);
    if (!stream.write(chunk)) {
      await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
    }
  }
  stream.end();
}

function stagingDirectoryCommand(directory: string): string {
  const parent = directory.startsWith("/tmp/.mcp/") ? "/tmp/.mcp" : directory;
  return [
    "set -e",
    "umask 077",
    `[ ! -L ${shellQuote(parent)} ] || { echo "staging parent must not be a symlink" >&2; exit 48; }`,
    `mkdir -p ${shellQuote(directory)}`,
    `[ "$(stat -c %u ${shellQuote(directory)})" = "$(id -u)" ] || { echo "staging directory has the wrong owner" >&2; exit 48; }`,
    `chmod 700 ${shellQuote(directory)}`,
  ].join("\n");
}

function writeSftpFile(
  sshConfig: SSHConfig,
  remotePath: string,
  payload: Buffer,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new FsToolError(504, `SFTP upload timed out after ${timeoutMs}ms`, "FS_TIMEOUT")),
      timeoutMs,
    );
    timer.unref?.();

    conn.on("ready", () => {
      conn.sftp((error: Error | undefined, sftp: SFTPWrapper) => {
        if (error) {
          finish(new FsToolError(502, "Failed to start SFTP staging", "FS_UPLOAD_FAILED"));
          return;
        }
        sftp.writeFile(remotePath, payload, { mode: 0o600 }, (writeError?: Error | null) => {
          finish(writeError ? new FsToolError(502, "Failed to upload the staging file", "FS_UPLOAD_FAILED") : undefined);
        });
      });
    });
    conn.on("error", () => finish(new FsToolError(502, "SSH connection failed during SFTP staging", "FS_CONNECT_FAILED")));
    conn.connect({ ...sshConfig, readyTimeout: 30_000 });
  });
}

export async function uploadStagingFile(
  sshConfig: SSHConfig,
  payload: Buffer,
  config: FsRuntimeConfig,
  directory = FS_STAGING_DIR,
): Promise<string> {
  const prepared = await runRemoteCommand(sshConfig, stagingDirectoryCommand(directory), { timeoutMs: config.timeoutMs });
  if (prepared.exitCode !== 0) throw failureMessage(prepared, directory);
  const remotePath = `${directory}/${randomUUID()}`;
  await writeSftpFile(sshConfig, remotePath, payload, config.timeoutMs);
  return remotePath;
}

export function runRemoteCommand(
  sshConfig: SSHConfig,
  command: string,
  options: { stdin?: Buffer; timeoutMs?: number } = {},
): Promise<RemoteCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
  return new Promise<RemoteCommandResult>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (error?: Error, result?: RemoteCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      if (error) reject(error);
      else resolve(result as RemoteCommandResult);
    };

    const timer = setTimeout(() => {
      finish(new FsToolError(504, `Remote file operation timed out after ${timeoutMs}ms`, "FS_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();

    conn.on("ready", () => {
      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          finish(new FsToolError(502, `SSH exec error: ${err.message}`, "FS_EXEC_FAILED"));
          return;
        }
        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("close", (code: number | null, signal: string | null) => {
          finish(undefined, { stdout, stderr, exitCode: code ?? null, signal: signal ?? null });
        });

        if (options.stdin && options.stdin.length > 0) {
          void writeStdin(stream, options.stdin).catch((error: Error) => {
            finish(new FsToolError(502, `Failed to send file content: ${error.message}`, "FS_UPLOAD_FAILED"));
          });
        } else {
          stream.end();
        }
      });
    });

    conn.on("error", () => {
      finish(new FsToolError(502, "SSH connection failed", "FS_CONNECT_FAILED"));
    });

    conn.connect({ ...sshConfig, readyTimeout: 30_000 });
  });
}

export function parseFsResultLine(stdout: string): { bytes: number; sha256: string; lineCount?: number } {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("FS_RESULT ") || candidate.startsWith("FS_UNCHANGED "));
  if (!line) {
    throw new FsToolError(502, "Remote file operation did not report a result", "FS_RESULT_MISSING");
  }
  const parts = line.trim().split(/\s+/);
  const bytes = Number.parseInt(parts[1] ?? "", 10);
  const sha256 = (parts[2] ?? "").toLowerCase();
  const lineCount = parts[3] === undefined ? undefined : Number.parseInt(parts[3], 10);
  if (!Number.isFinite(bytes) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new FsToolError(502, "Remote file operation returned an unreadable result", "FS_RESULT_INVALID");
  }
  return { bytes, sha256, lineCount: Number.isFinite(lineCount as number) ? lineCount : undefined };
}

export function parseWriteOutcome(stdout: string): {
  bytes: number;
  sha256: string;
  unchanged: boolean;
  backupPath?: string;
  createdDirs: string[];
} {
  const meta = parseFsResultLine(stdout);
  const lines = stdout.split("\n");
  return {
    bytes: meta.bytes,
    sha256: meta.sha256,
    unchanged: lines.some((line) => line.startsWith("FS_UNCHANGED ")),
    backupPath: lines.find((line) => line.startsWith("FS_BACKUP "))?.slice("FS_BACKUP ".length),
    createdDirs: lines.filter((line) => line.startsWith("FS_CREATED_DIR ")).map((line) => line.slice("FS_CREATED_DIR ".length)),
  };
}

function failureMessage(result: RemoteCommandResult, path: string): FsToolError {
  const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
  if (result.exitCode === 17) return new FsToolError(409, `File already exists: ${path}`, "FS_FILE_EXISTS");
  if (result.exitCode === 2) return new FsToolError(404, `File does not exist: ${path}`, "FS_FILE_MISSING");
  if (result.exitCode === 42) {
    const actual = detail.split("\n").find((line) => line.startsWith("FS_CONFLICT "))?.slice("FS_CONFLICT ".length) ?? "unknown";
    return new FsToolError(409, `File changed before the write. The current sha256 is ${actual}. Read it again before retrying.`, "FS_SHA256_MISMATCH");
  }
  if (result.exitCode === 44) return new FsToolError(404, `Parent directory does not exist for ${path}. Set create_dirs to true only after checking the path.`, "FS_PARENT_MISSING");
  if (result.exitCode === 45) return new FsToolError(413, `Remote file is larger than the configured edit limit: ${path}`, "FS_CONTENT_TOO_LARGE");
  if (result.exitCode === 77) return new FsToolError(403, `Canonical path is outside the allowed roots: ${path}`, "FS_PATH_FORBIDDEN");
  return new FsToolError(502, `Remote file operation failed (exit ${result.exitCode ?? "unknown"}): ${detail}`, "FS_OPERATION_FAILED");
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */
/* ------------------------------------------------------------------ */

function assertEnabled(config: FsRuntimeConfig): void {
  if (!config.enabled) {
    throw new FsToolError(403, "File tools are disabled on this deployment", "FS_TOOLS_DISABLED");
  }
}

export async function resolveCanonicalPath(
  sshConfig: SSHConfig,
  rawPath: unknown,
  config: FsRuntimeConfig,
  options: { allowMissing?: boolean; elevate?: boolean } = {},
): Promise<string> {
  const path = normalizeRemotePath(rawPath);
  const script = buildResolvePathScript(path, config.allowedRoots, Boolean(options.allowMissing), Boolean(options.elevate));
  const result = await runRemoteCommand(sshConfig, script, { timeoutMs: config.timeoutMs });
  if (result.exitCode !== 0) throw failureMessage(result, path);
  return parseResolvedPath(result.stdout);
}

export interface RemoteFileContent {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  totalLines: number;
  truncated: boolean;
}

export async function readRemoteFile(
  sshConfig: SSHConfig,
  rawPath: unknown,
  config: FsRuntimeConfig,
  offset = 1,
  limit = config.readMaxLines,
  elevate = false,
): Promise<RemoteFileContent> {
  const path = await resolveCanonicalPath(sshConfig, rawPath, config, { elevate });
  const script = buildReadScript(path, offset, limit, config.readMaxChars, elevate);
  const result = await runRemoteCommand(sshConfig, script, { timeoutMs: config.timeoutMs });
  if (result.exitCode !== 0) throw failureMessage(result, path);

  const meta = parseFsResultLine(result.stdout);
  const marker = `${FS_CONTENT_SENTINEL}\n`;
  const index = result.stdout.indexOf(marker);
  const rawContent = index === -1 ? "" : result.stdout.slice(index + marker.length);
  const contentTruncated = rawContent.length > config.readMaxChars;
  const content = contentTruncated ? rawContent.slice(0, config.readMaxChars) : rawContent;
  const totalLines = meta.lineCount ?? 0;
  const lineTruncated = totalLines >= offset + limit;
  return { path, content, bytes: meta.bytes, sha256: meta.sha256, totalLines, truncated: contentTruncated || lineTruncated };
}

export async function readRemoteFileRaw(
  sshConfig: SSHConfig,
  rawPath: unknown,
  config: FsRuntimeConfig,
  elevate = false,
): Promise<{ path: string; content: string; bytes: number; sha256: string }> {
  const path = await resolveCanonicalPath(sshConfig, rawPath, config, { elevate });
  const maxBytes = Number.isFinite(config.maxBytes) ? config.maxBytes : DEFAULT_FS_MAX_BYTES;
  const script = buildRawReadScript(path, maxBytes, elevate);
  const result = await runRemoteCommand(sshConfig, script, { timeoutMs: config.timeoutMs });
  if (result.exitCode !== 0) throw failureMessage(result, path);
  const meta = parseFsResultLine(result.stdout);
  const marker = `${FS_CONTENT_SENTINEL}\n`;
  const index = result.stdout.indexOf(marker);
  const content = index === -1 ? "" : result.stdout.slice(index + marker.length);
  if (content.length > maxBytes) {
    throw new FsToolError(413, `Remote file is larger than the configured edit limit: ${path}`, "FS_CONTENT_TOO_LARGE");
  }
  return { path, content, bytes: meta.bytes, sha256: meta.sha256 };
}

export async function runFsWrite(
  sshConfig: SSHConfig,
  args: JsonObject,
  config: FsRuntimeConfig,
  context: FsToolContext,
): Promise<JsonObject> {
  assertEnabled(config);
  const { payload, source, binary } = decodeFileContent(args);

  if (Number.isFinite(config.maxBytes) && payload.length > config.maxBytes) {
    throw new FsToolError(
      413,
      `content is too large (${payload.length} bytes, max ${config.maxBytes})`,
      "FS_CONTENT_TOO_LARGE",
    );
  }

  const elevate = Boolean(args.elevate);
  const createDirs = args.create_dirs === undefined ? false : Boolean(args.create_dirs);
  const path = await resolveCanonicalPath(sshConfig, args.path, config, { allowMissing: createDirs, elevate });
  const fileMode = parseFileMode(args.mode) ?? "0644";
  const owner = parseOwner(args.owner);
  const expectedSha = parseSha256(args.expected_sha256, "expected_sha256");
  const backup = args.backup === undefined ? true : Boolean(args.backup);
  const verify = Boolean(args.verify);
  const payloadSha = sha256Hex(payload);
  const syntaxCheckRequested = args.check_syntax === undefined ? config.syntaxCheckEnabled : Boolean(args.check_syntax);
  const stagingPath = await uploadStagingFile(sshConfig, payload, config);
  const syntaxCheck = syntaxCheckRequested ? syntaxCheckStatement(path, "$staging") : undefined;
  const backupSuffix = backup ? `.bak.${Date.now()}` : undefined;

  const script = buildWriteScript({
    path,
    stagingPath,
    createDirs,
    fileMode,
    owner,
    expectedSha,
    payloadSha,
    syntaxCheck,
    backupSuffix,
    verify,
    elevate,
  });

  const result = await runRemoteCommand(sshConfig, script, { timeoutMs: config.timeoutMs });
  if (result.exitCode !== 0) throw failureMessage(result, path);

  const outcome = parseWriteOutcome(result.stdout);
  const preview = buildPreview(source, config.previewMaxChars);

  return {
    status: "completed",
    tool: "fs-write",
    target_id: context.targetId,
    target_label: context.targetLabel,
    path,
    encoding: binary ? "base64" : "utf8",
    bytes_written: payload.length,
    sha256: outcome.sha256,
    backup_path: outcome.backupPath,
    unchanged: outcome.unchanged,
    created_dirs: outcome.createdDirs.length > 0 ? outcome.createdDirs : undefined,
    syntax_checked: Boolean(syntaxCheck),
    preview: preview.preview,
    preview_truncated: preview.preview_truncated,
    next_action: outcome.unchanged ? "The remote file already had this content." : "File written. Use run-script or a short exec command to act on it.",
  };
}

export async function runFsRead(
  sshConfig: SSHConfig,
  args: JsonObject,
  config: FsRuntimeConfig,
  context: FsToolContext,
): Promise<JsonObject> {
  assertEnabled(config);
  const offset = parsePositiveInteger(args.offset, "offset") ?? 1;
  const requestedLimit = parsePositiveInteger(args.limit, "limit") ?? config.readMaxLines;
  const limit = Math.min(requestedLimit, config.readMaxLines);
  const elevate = Boolean(args.elevate);
  const file = await readRemoteFile(sshConfig, args.path, config, offset, limit, elevate);

  return {
    status: "completed",
    tool: "fs-read",
    target_id: context.targetId,
    target_label: context.targetLabel,
    path: file.path,
    content: file.content,
    total_lines: file.totalLines,
    truncated: file.truncated,
    sha256: file.sha256,
    file_bytes: file.bytes,
    offset,
    limit,
  };
}

function matchLineNumbers(content: string, search: string): number[] {
  const lines: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(search, from);
    if (index === -1) break;
    lines.push(content.slice(0, index).split("\n").length);
    from = index + Math.max(1, search.length);
  }
  return lines;
}

export async function runFsEdit(
  sshConfig: SSHConfig,
  args: JsonObject,
  config: FsRuntimeConfig,
  context: FsToolContext,
): Promise<JsonObject> {
  assertEnabled(config);
  const elevate = Boolean(args.elevate);
  const oldStr = args.old_string;
  const newStr = args.new_string;
  if (typeof oldStr !== "string" || oldStr.length === 0) {
    throw new FsToolError(400, "old_string must be a non-empty string", "FS_EDIT_INVALID");
  }
  if (typeof newStr !== "string") {
    throw new FsToolError(400, "new_string must be a string", "FS_EDIT_INVALID");
  }

  const replaceAll = Boolean(args.replace_all);
  const expectedSha = parseSha256(args.expected_sha256, "expected_sha256");
  const file = await readRemoteFileRaw(sshConfig, args.path, config, elevate);

  if (expectedSha && expectedSha !== file.sha256) {
    throw new FsToolError(
      409,
      `File changed since it was read: expected ${expectedSha}, remote file is ${file.sha256}`,
      "FS_SHA256_MISMATCH",
    );
  }

  const lineNumbers = matchLineNumbers(file.content, oldStr);
  const occurrences = lineNumbers.length;
  if (occurrences === 0) {
    throw new FsToolError(
      404,
      "old_string was not found. Use fs-read to inspect the current content and preserve the exact indentation after the line-number prefix.",
      "FS_EDIT_NOT_FOUND",
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new FsToolError(
      409,
      `old_string matches ${occurrences} places on lines ${lineNumbers.join(", ")}. Send a longer old_string, or set replace_all to true.`,
      "FS_EDIT_AMBIGUOUS",
    );
  }

  const updated = replaceAll ? file.content.split(oldStr).join(newStr) : file.content.replace(oldStr, newStr);
  const payload = Buffer.from(updated, "utf8");
  if (Number.isFinite(config.maxBytes) && payload.length > config.maxBytes) {
    throw new FsToolError(413, `patched file is too large (${payload.length} bytes, max ${config.maxBytes})`, "FS_CONTENT_TOO_LARGE");
  }

  const backup = args.backup === undefined ? true : Boolean(args.backup);
  const backupSuffix = backup ? `.bak.${Date.now()}` : undefined;
  const syntaxCheckRequested = args.check_syntax === undefined ? config.syntaxCheckEnabled : Boolean(args.check_syntax);
  const stagingPath = await uploadStagingFile(sshConfig, payload, config);
  const syntaxCheck = syntaxCheckRequested ? syntaxCheckStatement(file.path, "$staging") : undefined;
  const payloadSha = sha256Hex(payload);

  const script = buildWriteScript({
    path: file.path,
    stagingPath,
    createDirs: false,
    fileMode: "0644",
    expectedSha: file.sha256,
    payloadSha,
    syntaxCheck,
    backupSuffix,
    verify: true,
    elevate,
    preserveMetadata: true,
  });
  const result = await runRemoteCommand(sshConfig, script, { timeoutMs: config.timeoutMs });
  if (result.exitCode !== 0) throw failureMessage(result, file.path);

  const outcome = parseWriteOutcome(result.stdout);
  const preview = buildPreview(newStr, config.previewMaxChars);

  return {
    status: "completed",
    tool: "fs-edit",
    target_id: context.targetId,
    target_label: context.targetLabel,
    path: file.path,
    replacements: replaceAll ? occurrences : 1,
    sha256: outcome.sha256,
    backup_path: outcome.backupPath,
    syntax_checked: Boolean(syntaxCheck),
    preview: preview.preview,
    preview_truncated: preview.preview_truncated,
    next_action: "Edit applied. Use fs-read to inspect the changed lines, or run a short exec command.",
  };
}

export function parsePositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new FsToolError(400, `${name} must be a positive integer`, "FS_RANGE_INVALID");
  }
  return Math.floor(parsed);
}

function parseStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new FsToolError(400, `${name} must be an array of strings`, "FS_SCRIPT_INVALID");
  }
  return value as string[];
}

function parseScriptEnvironment(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FsToolError(400, "env must be an object of string values", "FS_SCRIPT_INVALID");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string") {
      throw new FsToolError(400, "env keys must be shell variable names and values must be strings", "FS_SCRIPT_INVALID");
    }
    result[key] = item;
  }
  return result;
}

function parseWorkingDirectory(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "/") return "/";
  return normalizeRemotePath(value);
}

function buildScriptSyntaxCommand(path: string, interpreter: ScriptInterpreter, elevate: boolean): string {
  let command: string;
  if (interpreter === "bash" || interpreter === "sh") command = `${interpreter} -n ${shellQuote(path)}`;
  else if (interpreter === "python3") {
    command = `python3 -c ${shellQuote("import ast,sys;ast.parse(open(sys.argv[1]).read())")} ${shellQuote(path)}`;
  } else command = `node --check ${shellQuote(path)}`;
  return elevate ? `sudo -n sh -c ${shellQuote(command)}` : command;
}

export interface PreparedRunScript {
  path: string;
  command: string;
  stdin?: Buffer;
  timeoutMs?: number;
  temporary: boolean;
  syntaxChecked: boolean;
}

export async function prepareRunScript(
  sshConfig: SSHConfig,
  args: JsonObject,
  config: FsRuntimeConfig,
): Promise<PreparedRunScript> {
  assertEnabled(config);
  const hasContent = typeof args.content === "string";
  const hasPath = typeof args.path === "string" && args.path.trim().length > 0;
  if (hasContent === hasPath) {
    throw new FsToolError(400, "Provide exactly one of content or path", "FS_SCRIPT_INVALID");
  }

  const interpreter = parseInterpreter(args.interpreter);
  const elevate = Boolean(args.elevate);
  const scriptArgs = parseStringArray(args.args, "args");
  const env = parseScriptEnvironment(args.env);
  const cwd = parseWorkingDirectory(args.cwd);
  const checkSyntax = args.check_syntax === undefined ? true : Boolean(args.check_syntax);
  let path: string;
  let temporary = false;

  if (hasContent) {
    const source = String(args.content).replace(/\r\n?/g, "\n");
    const payload = Buffer.from(source, "utf8");
    if (Number.isFinite(config.maxBytes) && payload.length > config.maxBytes) {
      throw new FsToolError(413, `script content is too large (${payload.length} bytes, max ${config.maxBytes})`, "FS_CONTENT_TOO_LARGE");
    }
    path = await uploadStagingFile(sshConfig, payload, config, FS_SCRIPT_DIR);
    temporary = true;
  } else {
    path = await resolveCanonicalPath(sshConfig, args.path, config, { elevate });
  }

  if (checkSyntax) {
    const checked = await runRemoteCommand(sshConfig, buildScriptSyntaxCommand(path, interpreter, elevate), { timeoutMs: config.timeoutMs });
    if (checked.exitCode !== 0) {
      if (temporary) await runRemoteCommand(sshConfig, `rm -f ${shellQuote(path)}`, { timeoutMs: config.timeoutMs }).catch(() => undefined);
      const detail = (checked.stderr || checked.stdout).trim().slice(0, 2000);
      throw new FsToolError(400, `Script syntax check failed before execution: ${detail}`, "FS_SCRIPT_SYNTAX_INVALID");
    }
  }

  if (args.stdin !== undefined && typeof args.stdin !== "string") {
    throw new FsToolError(400, "stdin must be a string", "FS_SCRIPT_INVALID");
  }
  const stdin = args.stdin === undefined ? undefined : Buffer.from(args.stdin as string, "utf8");
  return {
    path,
    command: buildRunCommand(path, interpreter, { args: scriptArgs, cwd, env, elevate, cleanup: temporary }),
    stdin,
    timeoutMs: parsePositiveInteger(args.timeout_ms, "timeout_ms"),
    temporary,
    syntaxChecked: checkSyntax,
  };
}

/* ------------------------------------------------------------------ */
/* Tool descriptors                                                    */
/* ------------------------------------------------------------------ */

const NOTE_PROPERTY: JsonObject = {
  type: "string",
  minLength: 1,
  description: "Optional audit note explaining why this tool call is being made.",
};

const TARGET_ID_PROPERTY: JsonObject = {
  type: "string",
  description:
    "Optional server-side SSH profile ID. Required when no default profile is configured. Do not pass hostnames or credential material here.",
};

function fsSchema(properties: JsonObject, required: string[]): JsonObject {
  return {
    type: "object",
    properties: { target_id: TARGET_ID_PROPERTY, ...properties, note: NOTE_PROPERTY },
    required,
    additionalProperties: false,
  };
}

export const FS_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    status: { type: "string" },
    tool: { type: "string" },
    target_id: { type: "string" },
    target_label: { type: "string" },
    path: { type: "string" },
    encoding: { type: "string" },
    bytes_written: { type: "number" },
    sha256: { type: "string" },
    unchanged: { type: "boolean" },
    created_dirs: { type: "array", items: { type: "string" } },
    file_bytes: { type: "number" },
    backup_path: { type: "string" },
    replacements: { type: "number" },
    syntax_checked: { type: "boolean" },
    preview: { type: "string" },
    preview_truncated: { type: "boolean" },
    content: { type: "string" },
    total_lines: { type: "number" },
    truncated: { type: "boolean" },
    offset: { type: "number" },
    limit: { type: "number" },
    error: { type: "string" },
    code: { type: "string" },
    next_action: { type: "string" },
  },
  required: ["status"],
  additionalProperties: false,
};

export function fsToolDefinitions(config: FsRuntimeConfig): JsonObject[] {
  if (!config.enabled) return [];

  const contentProperty: JsonObject = {
    type: "string",
    description: "UTF-8 file content. Provide this or content_base64, but not both. The content is sent through SFTP, not the shell command line.",
  };

  return [
    {
      name: "fs-write",
      description:
        "Write a complete remote file through SFTP staging, then atomically install it. Read an existing file first and pass expected_sha256; a mismatch is rejected before backup or replacement. Canonical realpath is checked against SSH_MCP_FS_ALLOWED_ROOTS before the write. Set elevate for root-owned destinations. Parent directories are not created unless create_dirs is true.",
      inputSchema: fsSchema(
        {
          path: { type: "string", minLength: 1, description: "Absolute path of the remote file." },
          content: contentProperty,
          content_base64: { type: "string", description: "Base64 file content for binary data. Provide this or content, but not both." },
          expected_sha256: { type: "string", description: "sha256 returned by fs-read. If supplied, it is checked immediately before replacement." },
          mode: { type: "string", description: "Octal file mode such as 0644. Default is 0644." },
          owner: { type: "string", description: "Optional owner in user:group form, normally used with elevate." },
          elevate: { type: "boolean", description: "Use sudo -n for parent creation, backup, install, ownership, and replacement." },
          backup: { type: "boolean", description: "Back up an existing target before replacement. Default is true." },
          create_dirs: { type: "boolean", description: "Create a missing parent directory. Default is false." },
          normalize_newlines: { type: "boolean", description: "Convert CRLF and CR to LF for text content. Default is true." },
          verify: { type: "boolean", description: "Read the installed file hash and compare it with the staged content. Default is false." },
          check_syntax: { type: "boolean", description: "Check .sh, .py, and .json content before replacement. Defaults to deployment configuration." },
        },
        ["path"],
      ),
      outputSchema: FS_OUTPUT_SCHEMA,
      _meta: {
        "openai/toolInvocation/invoking": "Writing remote file",
        "openai/toolInvocation/invoked": "Remote file written",
      },
    },
    {
      name: "fs-read",
      description:
        "Read a bounded line window from a remote file. Lines use a fixed six-character line-number prefix followed by a tab. The remote command limits stdout before Node receives it. Use the returned sha256 with fs-write. Set elevate to read root-only files.",
      inputSchema: fsSchema(
        {
          path: { type: "string", minLength: 1, description: "Absolute path of the remote file." },
          offset: { type: "number", description: "First line to return, starting at 1. Default is 1." },
          limit: { type: "number", description: `Maximum lines to return. Default and deployment maximum are ${config.readMaxLines}.` },
          elevate: { type: "boolean", description: "Use sudo -n to resolve and read a root-only file." },
        },
        ["path"],
      ),
      outputSchema: FS_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
    {
      name: "fs-edit",
      description:
        "Replace exact text in a remote file and send only the changed content. Copy exact indentation from fs-read, but never include its line-number prefix in old_string. The final install rechecks the hash read by this call, so a concurrent modification is rejected before replacement. A backup is kept by default.",
      inputSchema: fsSchema(
        {
          path: { type: "string", minLength: 1, description: "Absolute path of the remote file." },
          old_string: { type: "string", minLength: 1, description: "Exact text and indentation to replace. Do not include fs-read line numbers." },
          new_string: { type: "string", description: "Replacement text. Use an empty string to delete the text." },
          replace_all: { type: "boolean", description: "Replace every match. Default is false." },
          backup: { type: "boolean", description: "Keep a backup copy of the original file. Default is true." },
          expected_sha256: { type: "string", description: "Optional sha256 from a prior fs-read. The tool also performs its own write-time conflict check." },
          elevate: { type: "boolean", description: "Use sudo -n for root-owned files." },
          check_syntax: { type: "boolean", description: "Check .sh, .py, and .json content before replacement." },
        },
        ["path", "old_string", "new_string"],
      ),
      outputSchema: FS_OUTPUT_SCHEMA,
    },
    {
      name: "run-script",
      description:
        "Run a multiline or structured script without putting its body on the shell command line. Provide exactly one of content or path. The interpreter is explicit and syntax is checked before execution by default. Use this instead of exec for newlines, heredocs, loops, if/case blocks, or function definitions.",
      inputSchema: fsSchema(
        {
          content: { type: "string", description: "Temporary script content uploaded through SFTP. Provide this or path, but not both." },
          path: { type: "string", minLength: 1, description: "Absolute path of an existing remote script. Provide this or content, but not both." },
          interpreter: { type: "string", enum: ["bash", "sh", "python3", "node"], description: "Explicit interpreter. Default is bash." },
          args: { type: "array", items: { type: "string" }, description: "Arguments passed to the script without shell interpolation." },
          cwd: { type: "string", description: "Optional absolute working directory." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Optional environment variables." },
          check_syntax: { type: "boolean", description: "Check syntax before execution. Default is true." },
          elevate: { type: "boolean", description: "Run the interpreter through sudo -n." },
          timeout_ms: { type: "number", description: "Optional hard execution deadline in milliseconds." },
          stdin: { type: "string", description: "Optional standard input for the script." },
        },
        [],
      ),
      _meta: {
        "openai/toolInvocation/invoking": "Running remote script",
        "openai/toolInvocation/invoked": "Remote script finished",
      },
    },
  ];
}

export function isFsToolName(name: string): name is FsToolName {
  return (FS_TOOL_NAMES as readonly string[]).includes(name);
}

export function redactFsArgs(args: JsonObject): JsonObject {
  const redacted: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if ((key === "content" || key === "content_base64" || key === "old_string" || key === "new_string" || key === "stdin") && typeof value === "string") {
      redacted[key] = `[redacted ${key}, ${value.length} chars, sha256 ${sha256Hex(value).slice(0, 12)}]`;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
