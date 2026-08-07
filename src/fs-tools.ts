/**
 * Remote file tools for the long command optimization work (ZER-496).
 *
 * The connector used to have only `exec`. To put a file on a remote host the
 * caller had to put the full file body inside one shell command. This module
 * removes that need: the file body travels over the SSH channel stdin as
 * base64 and only the quoted path goes into the command line.
 */

import { createHash } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";
import type { SSHConfig } from "./index.js";

export type JsonObject = Record<string, unknown>;

export const FS_TOOL_NAMES = ["fs-write", "fs-read", "fs-patch", "write-and-run"] as const;
export type FsToolName = (typeof FS_TOOL_NAMES)[number];

export const DEFAULT_FS_MAX_BYTES = 2_000_000;
export const DEFAULT_FS_PREVIEW_MAX_CHARS = 400;
export const DEFAULT_FS_READ_MAX_CHARS = 200_000;
export const DEFAULT_FS_TIMEOUT_MS = 60_000;
export const FS_CONTENT_SENTINEL = "---FS-CONTENT---";

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

export function parseAllowedRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeRemotePath(item));
}

export function loadFsRuntimeConfig(env: NodeJS.ProcessEnv = process.env): FsRuntimeConfig {
  return {
    enabled: parseFsFlag(envValue(env, "SSH_MCP_FS_TOOLS_ENABLED"), true),
    allowedRoots: parseAllowedRoots(envValue(env, "SSH_MCP_FS_ALLOWED_ROOTS")),
    maxBytes: parseFsLimit(envValue(env, "SSH_MCP_FS_MAX_BYTES"), DEFAULT_FS_MAX_BYTES, "SSH_MCP_FS_MAX_BYTES"),
    previewMaxChars: parseFsLimit(
      envValue(env, "SSH_MCP_FS_PREVIEW_MAX_CHARS"),
      DEFAULT_FS_PREVIEW_MAX_CHARS,
      "SSH_MCP_FS_PREVIEW_MAX_CHARS",
    ),
    readMaxChars: parseFsLimit(
      envValue(env, "SSH_MCP_FS_READ_MAX_CHARS"),
      DEFAULT_FS_READ_MAX_CHARS,
      "SSH_MCP_FS_READ_MAX_CHARS",
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
  if (allowedRoots.length === 0) return;
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

/** Returns a shell statement that validates the uploaded temporary file. */
export function syntaxCheckStatement(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) {
    return 'if command -v bash >/dev/null 2>&1; then bash -n "$tmp"; else sh -n "$tmp"; fi';
  }
  if (lower.endsWith(".py")) {
    return 'if command -v python3 >/dev/null 2>&1; then python3 -c "import ast,sys;ast.parse(open(sys.argv[1]).read())" "$tmp"; fi';
  }
  if (lower.endsWith(".json")) {
    return 'if command -v python3 >/dev/null 2>&1; then python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$tmp"; fi';
  }
  return undefined;
}

export interface WriteScriptOptions {
  path: string;
  mode: FsWriteMode;
  createDirs: boolean;
  fileMode?: string;
  syntaxCheck?: string;
  backupSuffix?: string;
}

export function buildWriteScript(options: WriteScriptOptions): string {
  const lines: string[] = [
    "set -e",
    `target=${shellQuote(options.path)}`,
    'tmp="$target.ssh-mcp-tmp.$$"',
    'trap \'rm -f "$tmp"\' EXIT',
    DIGEST_FUNCTION,
  ];

  if (options.createDirs) {
    lines.push('mkdir -p "$(dirname "$target")"');
  }
  if (options.mode === "create") {
    lines.push('if [ -e "$target" ]; then echo "file already exists: $target" >&2; exit 17; fi');
  }
  if (options.mode === "append") {
    lines.push('if [ ! -e "$target" ]; then echo "file does not exist: $target" >&2; exit 2; fi');
  }

  lines.push('base64 -d > "$tmp"');

  if (options.syntaxCheck) {
    lines.push(options.syntaxCheck);
  }
  if (options.backupSuffix) {
    lines.push(`if [ -e "$target" ]; then cp -p "$target" "$target${options.backupSuffix}"; fi`);
  }

  if (options.mode === "append") {
    lines.push('cat "$tmp" >> "$target"');
    lines.push('rm -f "$tmp"');
  } else {
    if (options.fileMode) lines.push(`chmod ${options.fileMode} "$tmp"`);
    lines.push('mv -f "$tmp" "$target"');
  }

  lines.push('size=$(wc -c < "$target" | tr -d " ")');
  lines.push('digest=$(fs_digest "$target")');
  lines.push("printf 'FS_RESULT %s %s\\n' \"$size\" \"$digest\"");
  return lines.join("\n");
}

export function buildReadScript(path: string, startLine?: number, endLine?: number): string {
  const lines: string[] = [
    "set -e",
    `target=${shellQuote(path)}`,
    'if [ ! -f "$target" ]; then echo "file not found: $target" >&2; exit 2; fi',
    DIGEST_FUNCTION,
    'size=$(wc -c < "$target" | tr -d " ")',
    'line_count=$(wc -l < "$target" | tr -d " ")',
    'digest=$(fs_digest "$target")',
    "printf 'FS_RESULT %s %s %s\\n' \"$size\" \"$digest\" \"$line_count\"",
    `printf '%s\\n' ${shellQuote(FS_CONTENT_SENTINEL)}`,
  ];

  if (startLine === undefined && endLine === undefined) {
    lines.push('cat "$target"');
  } else {
    const start = startLine ?? 1;
    const end = endLine ?? 0;
    const range = end > 0 ? `${start},${end}p` : `${start},$p`;
    lines.push(`sed -n '${range}' "$target"`);
  }
  return lines.join("\n");
}

export function buildRunCommand(path: string, runCommand?: unknown, interpreter?: unknown): string {
  if (typeof runCommand === "string" && runCommand.trim()) return runCommand.trim();

  if (typeof interpreter === "string" && interpreter.trim()) {
    const value = interpreter.trim();
    if (!/^[A-Za-z0-9_./-]+$/.test(value)) {
      throw new FsToolError(400, "interpreter contains unsupported characters", "FS_INTERPRETER_INVALID");
    }
    return `${value} ${shellQuote(path)}`;
  }

  const lower = path.toLowerCase();
  if (lower.endsWith(".py")) return `python3 ${shellQuote(path)}`;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return `node ${shellQuote(path)}`;
  return `bash ${shellQuote(path)}`;
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

    conn.on("error", (err: Error) => {
      finish(new FsToolError(502, `SSH connection error: ${err.message}`, "FS_CONNECT_FAILED"));
    });

    conn.connect(sshConfig);
  });
}

export function parseFsResultLine(stdout: string): { bytes: number; sha256: string; lineCount?: number } {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("FS_RESULT "));
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

function failureMessage(result: RemoteCommandResult, path: string): FsToolError {
  const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
  if (result.exitCode === 17) return new FsToolError(409, `File already exists: ${path}`, "FS_FILE_EXISTS");
  if (result.exitCode === 2) return new FsToolError(404, `File does not exist: ${path}`, "FS_FILE_MISSING");
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

function resolvePath(args: JsonObject, config: FsRuntimeConfig): string {
  const path = normalizeRemotePath(args.path);
  assertPathAllowed(path, config.allowedRoots);
  return path;
}

export interface RemoteFileContent {
  content: string;
  bytes: number;
  sha256: string;
  lineCount?: number;
}

export async function readRemoteFile(
  sshConfig: SSHConfig,
  path: string,
  config: FsRuntimeConfig,
  startLine?: number,
  endLine?: number,
): Promise<RemoteFileContent> {
  const script = buildReadScript(path, startLine, endLine);
  const result = await runRemoteCommand(sshConfig, script, { timeoutMs: config.timeoutMs });
  if (result.exitCode !== 0) throw failureMessage(result, path);

  const meta = parseFsResultLine(result.stdout);
  const marker = `${FS_CONTENT_SENTINEL}\n`;
  const index = result.stdout.indexOf(marker);
  const content = index === -1 ? "" : result.stdout.slice(index + marker.length);
  return { content, bytes: meta.bytes, sha256: meta.sha256, lineCount: meta.lineCount };
}

export async function runFsWrite(
  sshConfig: SSHConfig,
  args: JsonObject,
  config: FsRuntimeConfig,
  context: FsToolContext,
): Promise<JsonObject> {
  assertEnabled(config);
  const path = resolvePath(args, config);
  const mode = parseWriteMode(args.mode);
  const encoding = parseEncoding(args.encoding);
  const payload = decodeContent(args.content, encoding);

  if (Number.isFinite(config.maxBytes) && payload.length > config.maxBytes) {
    throw new FsToolError(
      413,
      `content is too large (${payload.length} bytes, max ${config.maxBytes}). Split the write into append chunks.`,
      "FS_CONTENT_TOO_LARGE",
    );
  }

  const syntaxCheckRequested = args.syntax_check === undefined ? config.syntaxCheckEnabled : Boolean(args.syntax_check);
  const syntaxCheck = mode === "append" || !syntaxCheckRequested ? undefined : syntaxCheckStatement(path);
  const expectedSha = parseSha256(args.expected_sha256, "expected_sha256");
  const createDirs = args.create_dirs === undefined ? true : Boolean(args.create_dirs);

  const script = buildWriteScript({
    path,
    mode,
    createDirs,
    fileMode: parseFileMode(args.file_mode),
    syntaxCheck,
  });

  const result = await runRemoteCommand(sshConfig, script, {
    stdin: Buffer.from(payload.toString("base64"), "utf8"),
    timeoutMs: config.timeoutMs,
  });
  if (result.exitCode !== 0) throw failureMessage(result, path);

  const meta = parseFsResultLine(result.stdout);
  if (expectedSha && expectedSha !== meta.sha256) {
    throw new FsToolError(
      409,
      `sha256 mismatch after write: expected ${expectedSha}, remote file is ${meta.sha256}`,
      "FS_SHA256_MISMATCH",
    );
  }

  const previewSource = encoding === "utf8" ? String(args.content) : payload.toString("utf8");
  const preview = buildPreview(previewSource, config.previewMaxChars);

  return {
    status: "completed",
    tool: "fs-write",
    target_id: context.targetId,
    target_label: context.targetLabel,
    path,
    mode,
    encoding,
    bytes_written: payload.length,
    chunk_sha256: sha256Hex(payload),
    file_bytes: meta.bytes,
    file_sha256: meta.sha256,
    syntax_checked: Boolean(syntaxCheck),
    expected_sha256_verified: expectedSha ? true : undefined,
    preview: preview.preview,
    preview_truncated: preview.preview_truncated,
    next_action:
      mode === "append"
        ? "Chunk appended. Send the next chunk, or send expected_sha256 on the last chunk to verify the complete file."
        : "File written. Run a short exec command against the path instead of resending the content.",
  };
}

export async function runFsRead(
  sshConfig: SSHConfig,
  args: JsonObject,
  config: FsRuntimeConfig,
  context: FsToolContext,
): Promise<JsonObject> {
  assertEnabled(config);
  const path = resolvePath(args, config);
  const startLine = parsePositiveInteger(args.start_line, "start_line");
  const endLine = parsePositiveInteger(args.end_line, "end_line");
  if (startLine && endLine && endLine < startLine) {
    throw new FsToolError(400, "end_line must be greater than or equal to start_line", "FS_RANGE_INVALID");
  }

  const file = await readRemoteFile(sshConfig, path, config, startLine, endLine);
  const limit = config.readMaxChars;
  const truncated = Number.isFinite(limit) && file.content.length > limit;
  const content = truncated ? file.content.slice(0, limit) : file.content;

  return {
    status: "completed",
    tool: "fs-read",
    target_id: context.targetId,
    target_label: context.targetLabel,
    path,
    content,
    content_truncated: truncated,
    returned_chars: content.length,
    file_bytes: file.bytes,
    file_sha256: file.sha256,
    line_count: file.lineCount,
    start_line: startLine,
    end_line: endLine,
  };
}

export async function runFsPatch(
  sshConfig: SSHConfig,
  args: JsonObject,
  config: FsRuntimeConfig,
  context: FsToolContext,
): Promise<JsonObject> {
  assertEnabled(config);
  const path = resolvePath(args, config);
  const oldStr = args.old_str;
  const newStr = args.new_str;
  if (typeof oldStr !== "string" || oldStr.length === 0) {
    throw new FsToolError(400, "old_str must be a non-empty string", "FS_PATCH_INVALID");
  }
  if (typeof newStr !== "string") {
    throw new FsToolError(400, "new_str must be a string", "FS_PATCH_INVALID");
  }

  const replaceAll = Boolean(args.replace_all);
  const expectedSha = parseSha256(args.expected_sha256, "expected_sha256");
  const file = await readRemoteFile(sshConfig, path, config);

  if (expectedSha && expectedSha !== file.sha256) {
    throw new FsToolError(
      409,
      `File changed since it was read: expected ${expectedSha}, remote file is ${file.sha256}`,
      "FS_SHA256_MISMATCH",
    );
  }

  const occurrences = file.content.split(oldStr).length - 1;
  if (occurrences === 0) {
    throw new FsToolError(404, "old_str was not found in the file", "FS_PATCH_NOT_FOUND");
  }
  if (occurrences > 1 && !replaceAll) {
    throw new FsToolError(
      409,
      `old_str matches ${occurrences} places. Send a longer old_str, or set replace_all to true.`,
      "FS_PATCH_AMBIGUOUS",
    );
  }

  const updated = replaceAll ? file.content.split(oldStr).join(newStr) : file.content.replace(oldStr, newStr);
  const payload = Buffer.from(updated, "utf8");
  if (Number.isFinite(config.maxBytes) && payload.length > config.maxBytes) {
    throw new FsToolError(413, `patched file is too large (${payload.length} bytes, max ${config.maxBytes})`, "FS_CONTENT_TOO_LARGE");
  }

  const backup = args.backup === undefined ? true : Boolean(args.backup);
  const backupSuffix = backup ? `.bak.${Date.now()}` : undefined;
  const syntaxCheckRequested = args.syntax_check === undefined ? config.syntaxCheckEnabled : Boolean(args.syntax_check);
  const syntaxCheck = syntaxCheckRequested ? syntaxCheckStatement(path) : undefined;

  const script = buildWriteScript({ path, mode: "overwrite", createDirs: false, syntaxCheck, backupSuffix });
  const result = await runRemoteCommand(sshConfig, script, {
    stdin: Buffer.from(payload.toString("base64"), "utf8"),
    timeoutMs: config.timeoutMs,
  });
  if (result.exitCode !== 0) throw failureMessage(result, path);

  const meta = parseFsResultLine(result.stdout);
  const preview = buildPreview(newStr, config.previewMaxChars);

  return {
    status: "completed",
    tool: "fs-patch",
    target_id: context.targetId,
    target_label: context.targetLabel,
    path,
    replacements: replaceAll ? occurrences : 1,
    file_bytes_before: file.bytes,
    file_sha256_before: file.sha256,
    file_bytes: meta.bytes,
    file_sha256: meta.sha256,
    backup_path: backupSuffix ? `${path}${backupSuffix}` : undefined,
    syntax_checked: Boolean(syntaxCheck),
    preview: preview.preview,
    preview_truncated: preview.preview_truncated,
    next_action: "Patch applied. Use fs-read to confirm the result, or run a short exec command.",
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
    mode: { type: "string" },
    encoding: { type: "string" },
    bytes_written: { type: "number" },
    chunk_sha256: { type: "string" },
    file_bytes: { type: "number" },
    file_sha256: { type: "string" },
    file_bytes_before: { type: "number" },
    file_sha256_before: { type: "string" },
    backup_path: { type: "string" },
    replacements: { type: "number" },
    syntax_checked: { type: "boolean" },
    expected_sha256_verified: { type: "boolean" },
    preview: { type: "string" },
    preview_truncated: { type: "boolean" },
    content: { type: "string" },
    content_truncated: { type: "boolean" },
    returned_chars: { type: "number" },
    line_count: { type: "number" },
    start_line: { type: "number" },
    end_line: { type: "number" },
    run: { type: "object" },
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
    description: "File content. The content is sent over the SSH channel, not on the shell command line.",
  };

  return [
    {
      name: "fs-write",
      description:
        "Write a file on a server-side configured SSH profile without putting the file body on the shell command line. Use this tool instead of a here-document when the content is long, or when it holds quotes, backticks, or dollar signs. Use mode overwrite for the first chunk and mode append for each later chunk. Send expected_sha256 with the last chunk to verify the complete file. The result gives the byte count, the sha256 value, and a short preview.",
      inputSchema: fsSchema(
        {
          path: { type: "string", minLength: 1, description: "Absolute path of the remote file." },
          content: contentProperty,
          mode: { type: "string", enum: ["create", "overwrite", "append"], description: "Write mode. Default is overwrite." },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Encoding of content. Default is utf8." },
          create_dirs: { type: "boolean", description: "Create the parent directory when it does not exist. Default is true." },
          file_mode: { type: "string", description: "Optional octal file mode such as 644 or 0755." },
          expected_sha256: { type: "string", description: "Optional sha256 of the complete file. The tool fails when the remote file is different." },
          syntax_check: { type: "boolean", description: "Check .sh, .py, and .json files before the file is moved into place." },
        },
        ["path", "content"],
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
        "Read a remote file, or a line window of it, from a server-side configured SSH profile. The result gives the content, the byte count, the sha256 value, and truncation metadata. Use the sha256 value with fs-patch to make a safe edit.",
      inputSchema: fsSchema(
        {
          path: { type: "string", minLength: 1, description: "Absolute path of the remote file." },
          start_line: { type: "number", description: "Optional first line to return, starting at 1." },
          end_line: { type: "number", description: "Optional last line to return." },
        },
        ["path"],
      ),
      outputSchema: FS_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
    {
      name: "fs-patch",
      description:
        "Replace one exact string in a remote file. The tool fails when old_str is not found, and it fails when old_str matches more than one place and replace_all is false. Pass expected_sha256 from fs-read to reject a file that changed. A backup copy is kept by default.",
      inputSchema: fsSchema(
        {
          path: { type: "string", minLength: 1, description: "Absolute path of the remote file." },
          old_str: { type: "string", minLength: 1, description: "Exact text to replace." },
          new_str: { type: "string", description: "Replacement text. Use an empty string to delete the text." },
          replace_all: { type: "boolean", description: "Replace every match. Default is false." },
          backup: { type: "boolean", description: "Keep a backup copy of the original file. Default is true." },
          expected_sha256: { type: "string", description: "Optional sha256 of the file before the patch." },
          syntax_check: { type: "boolean", description: "Check .sh, .py, and .json files before the file is moved into place." },
        },
        ["path", "old_str", "new_str"],
      ),
      outputSchema: FS_OUTPUT_SCHEMA,
    },
    {
      name: "write-and-run",
      description:
        "Write a script on a server-side configured SSH profile and then run it. This is the preferred way to run a long or complex script: the body goes to the file, and only a short command goes to the shell. The run result uses the same background job behavior as exec, so a long run returns a job_id for exec-status.",
      inputSchema: fsSchema(
        {
          path: { type: "string", minLength: 1, description: "Absolute path of the remote script." },
          content: contentProperty,
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Encoding of content. Default is utf8." },
          file_mode: { type: "string", description: "Optional octal file mode such as 755." },
          interpreter: { type: "string", description: "Optional interpreter such as bash, sh, or python3. The default comes from the file extension." },
          run_command: { type: "string", description: "Optional complete command to run instead of the default interpreter call." },
          syntax_check: { type: "boolean", description: "Check .sh, .py, and .json files before the file is moved into place." },
          expire_time_ms: { type: "number", description: "Optional time to wait before the run returns a job_id." },
          kill_time_ms: { anyOf: [{ type: "number" }, { type: "string", enum: ["none"] }], description: "Optional hard deadline for the background run." },
        },
        ["path", "content"],
      ),
      outputSchema: FS_OUTPUT_SCHEMA,
      _meta: {
        "openai/toolInvocation/invoking": "Writing and running remote script",
        "openai/toolInvocation/invoked": "Remote script started",
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
    if ((key === "content" || key === "old_str" || key === "new_str") && typeof value === "string") {
      redacted[key] = `[redacted ${key}, ${value.length} chars, sha256 ${sha256Hex(value).slice(0, 12)}]`;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
