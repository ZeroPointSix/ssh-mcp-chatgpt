import { createHash, randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import type { SSHConfig } from "./index.js";

const MAX_REMOTE_FILE_BYTES = 8 * 1024 * 1024;
const MCP_USER_ROOT = "/tmp/.mcp/users";

export function remoteWorkspaceRoot(context: RemoteToolContext, kind: "staging" | "scripts"): string {
  const safeUser = context.sshConfig.username.replace(/[^A-Za-z0-9_.-]/g, "_") || "unknown";
  return `${MCP_USER_ROOT}/${safeUser}/${kind}`;
}

export class RemoteToolError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RemoteToolError";
  }
}

export interface RemoteToolContext {
  sshConfig: SSHConfig;
  sudoPassword?: string;
  allowedRoots?: string[];
}

export interface RemoteReadOptions {
  path: string;
  offset?: number;
  limit?: number;
  elevate?: boolean;
}

export interface RemoteWriteOptions {
  path: string;
  content?: string;
  contentBase64?: string;
  expectedSha256?: string;
  mode?: string;
  owner?: string;
  elevate?: boolean;
  backup?: boolean;
  createDirs?: boolean;
  normalizeNewlines?: boolean;
  verify?: boolean;
}

export interface RemoteEditOptions {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  elevate?: boolean;
  backup?: boolean;
}

export type ScriptInterpreter = "bash" | "sh" | "python3" | "node";

export interface PrepareScriptOptions {
  content?: string;
  path?: string;
  interpreter?: ScriptInterpreter;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  checkSyntax?: boolean;
  elevate?: boolean;
  timeoutMs?: number;
  stdin?: string;
}

export interface PreparedScript {
  command: string;
  commandLength: number;
  stdin?: string;
  timeoutMs?: number;
  cleanup?: () => Promise<void>;
}

interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
}

function quoteShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const MANAGED_JOB_ROOT = "/tmp/.mcp/jobs";

function managedJobPidPath(jobId: string): string {
  if (!/^job-[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new RemoteToolError("policy", "Invalid managed job ID");
  }
  return MANAGED_JOB_ROOT + "/" + jobId + ".pid";
}

export function wrapManagedRemoteCommand(
  command: string,
  options: { usesStdin?: boolean; jobId?: string } = {},
): string {
  void options.usesStdin;
  const pidPath = options.jobId ? managedJobPidPath(options.jobId) : undefined;
  const setup = pidPath
    ? "pid_file=" + quoteShell(pidPath) +
      "; umask 077; mkdir -p " + quoteShell(MANAGED_JOB_ROOT) +
      "; printf '%s\\n' \"$$\" > \"$pid_file\"" +
      "; trap 'rm -f -- \"$pid_file\"' EXIT; "
    : "";
  const inner =
    setup +
    "trap 'trap \"\" TERM; kill -TERM -- -$$ 2>/dev/null || true; trap - TERM INT HUP; exit 143' TERM INT HUP; " +
    command +
    "\nexit $?";
  return "setsid --wait bash -c " + quoteShell(inner);
}

export function buildManagedRemoteCancelCommand(jobId: string): string {
  const pidPath = managedJobPidPath(jobId);
  const inner = [
    "pid_file=" + quoteShell(pidPath),
    "attempt=0",
    "while [ ! -s \"$pid_file\" ] && [ \"$attempt\" -lt 20 ]; do attempt=$((attempt + 1)); sleep 0.05; done",
    "[ -s \"$pid_file\" ] || exit 3",
    "pid=$(cat -- \"$pid_file\")",
    "case \"$pid\" in ''|*[!0-9]*) exit 4 ;; esac",
    "kill -TERM -- \"-$pid\" 2>/dev/null || true",
    "sleep 0.25",
    "kill -KILL -- \"-$pid\" 2>/dev/null || true",
    "rm -f -- \"$pid_file\"",
  ].join("; ");
  return "bash -c " + quoteShell(inner);
}

export function buildSyntaxCheckCommand(interpreter: ScriptInterpreter, path: string): string {
  return syntaxCommand(interpreter, path);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertAbsolutePath(value: string, name = "path"): void {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new RemoteToolError("policy", name + " must be an absolute remote path");
  }
}

function assertMode(mode: string): void {
  if (!/^0?[0-7]{3,4}$/.test(mode)) {
    throw new RemoteToolError("policy", "mode must be an octal string such as 0644");
  }
}

function parseOwner(owner: string): { user: string; group?: string } {
  const match = /^([A-Za-z0-9_.-]+)(?::([A-Za-z0-9_.-]+))?$/.exec(owner);
  if (!match) throw new RemoteToolError("policy", "owner must use user or user:group format");
  return { user: match[1], group: match[2] };
}

function elevateCommand(command: string, password?: string): string {
  if (!password) return "sudo -n sh -c " + quoteShell(command);
  return (
    "printf '%s\\n' " +
    quoteShell(password) +
    " | sudo -p '' -S sh -c " +
    quoteShell(command)
  );
}

function commandForElevation(command: string, elevate: boolean, context: RemoteToolContext): string {
  return elevate ? elevateCommand(command, context.sudoPassword) : command;
}

function connectSsh(config: SSHConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.once("ready", () => {
      settled = true;
      resolve(conn);
    });
    conn.once("error", (error: Error) => {
      if (!settled) reject(new RemoteToolError("connect", "SSH connection failed"));
    });
    conn.connect(config);
  });
}

async function withClient<T>(config: SSHConfig, callback: (conn: Client) => Promise<T>): Promise<T> {
  const conn = await connectSsh(config);
  try {
    return await callback(conn);
  } finally {
    try {
      conn.end();
    } catch {
      // Ignore connection cleanup errors.
    }
  }
}

function execCommand(
  conn: Client,
  command: string,
  stdin?: string,
  timeoutMs = 60_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (error: Error | undefined, stream: ClientChannel) => {
      if (error) {
        reject(new RemoteToolError("exec", "Failed to start remote command"));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          stream.close();
        } catch {
          // Ignore close errors after timeout.
        }
        reject(new RemoteToolError("timeout", "Remote command exceeded timeout_ms"));
      }, timeoutMs);
      timer.unref?.();

      const append = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
        const nextBytes = currentBytes + chunk.length;
        if (nextBytes > MAX_REMOTE_FILE_BYTES) {
          throw new RemoteToolError("output", "Remote command output exceeded 8 MiB");
        }
        chunks.push(Buffer.from(chunk));
        return nextBytes;
      };

      stream.on("data", (chunk: Buffer) => {
        try {
          stdoutBytes = append(stdout, chunk, stdoutBytes);
        } catch (cause) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try {
              stream.close();
            } catch {
              // Ignore close errors after output overflow.
            }
            reject(cause);
          }
        }
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        try {
          stderrBytes = append(stderr, chunk, stderrBytes);
        } catch (cause) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try {
              stream.close();
            } catch {
              // Ignore close errors after output overflow.
            }
            reject(cause);
          }
        }
      });
      stream.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RemoteToolError("exec", "Remote command channel failed"));
      });
      stream.on("close", (exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });

      if (stdin === undefined) stream.end();
      else stream.end(stdin);
    });
  });
}

async function checkedCommand(
  conn: Client,
  command: string,
  stage: string,
  stdin?: string,
  timeoutMs?: number,
): Promise<CommandResult> {
  const result = await execCommand(conn, command, stdin, timeoutMs);
  if (result.exitCode !== 0 || result.signal) {
    const detail = (result.stderr.length ? result.stderr : result.stdout).toString("utf8").trim();
    throw new RemoteToolError(stage, detail || "Remote command failed", {
      exit_code: result.exitCode,
      signal: result.signal,
    });
  }
  return result;
}

function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) reject(new RemoteToolError("sftp", "Failed to open SFTP channel"));
      else resolve(sftp);
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (error, data) => {
      if (error) {
        reject(new RemoteToolError("read", "Unable to read remote file"));
        return;
      }
      const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (content.length > MAX_REMOTE_FILE_BYTES) {
        reject(new RemoteToolError("read", "Remote file exceeds 8 MiB"));
        return;
      }
      resolve(content);
    });
  });
}

function sftpStat(
  sftp: SFTPWrapper,
  path: string,
): Promise<{ size: number; mode: number; uid: number; gid: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, attrs) => {
      if (error) {
        reject(new RemoteToolError("stat", "Unable to inspect remote file"));
        return;
      }
      resolve({ size: attrs.size, mode: attrs.mode, uid: attrs.uid, gid: attrs.gid });
    });
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, { mode: 0o600 }, (error) => {
      if (error) reject(new RemoteToolError("write", "Unable to upload staging file"));
      else resolve();
    });
  });
}

function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.unlink(path, () => resolve());
  });
}

async function canonicalizePath(
  conn: Client,
  path: string,
  context: RemoteToolContext,
): Promise<string> {
  assertAbsolutePath(path);
  const result = await checkedCommand(
    conn,
    "realpath -m -- " + quoteShell(path),
    "path",
  );
  const canonical = result.stdout.toString("utf8").trim();
  assertAbsolutePath(canonical);

  const roots = context.allowedRoots?.length ? context.allowedRoots : ["/"];
  const allowed = roots.some((root) => {
    const normalized = root === "/" ? "/" : root.replace(/\/+$/, "");
    return normalized === "/" || canonical === normalized || canonical.startsWith(normalized + "/");
  });
  if (!allowed) {
    throw new RemoteToolError("policy", "Remote path is outside the configured allowed roots");
  }
  return canonical;
}

async function readBuffer(
  conn: Client,
  path: string,
  elevate: boolean,
  context: RemoteToolContext,
): Promise<Buffer> {
  if (elevate) {
    const sizeResult = await checkedCommand(
      conn,
      commandForElevation("stat -c %s -- " + quoteShell(path), true, context),
      "stat",
    );
    const size = Number(sizeResult.stdout.toString("utf8").trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RemoteToolError("stat", "Remote file size is invalid");
    }
    if (size > MAX_REMOTE_FILE_BYTES) {
      throw new RemoteToolError("read", "Remote file exceeds 8 MiB");
    }
    const result = await checkedCommand(
      conn,
      commandForElevation("cat -- " + quoteShell(path), true, context),
      "read",
    );
    if (result.stdout.length > MAX_REMOTE_FILE_BYTES) {
      throw new RemoteToolError("read", "Remote file exceeds 8 MiB");
    }
    return result.stdout;
  }
  const sftp = await openSftp(conn);
  const attrs = await sftpStat(sftp, path);
  if (attrs.size > MAX_REMOTE_FILE_BYTES) {
    throw new RemoteToolError("read", "Remote file exceeds 8 MiB");
  }
  return sftpReadFile(sftp, path);
}

async function remoteFileMetadata(
  conn: Client,
  path: string,
  elevate: boolean,
  context: RemoteToolContext,
): Promise<{ mode: string; uid: number; gid: number }> {
  if (!elevate) {
    const attrs = await sftpStat(await openSftp(conn), path);
    return {
      mode: (attrs.mode & 0o7777).toString(8).padStart(4, "0"),
      uid: attrs.uid,
      gid: attrs.gid,
    };
  }
  const result = await checkedCommand(
    conn,
    commandForElevation("stat -c '%a %u %g' -- " + quoteShell(path), true, context),
    "stat",
  );
  const [rawMode, rawUid, rawGid] = result.stdout.toString("utf8").trim().split(/\s+/);
  const uid = Number(rawUid);
  const gid = Number(rawGid);
  const mode = rawMode?.padStart(4, "0");
  if (!mode || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new RemoteToolError("stat", "Remote file metadata is invalid");
  }
  assertMode(mode);
  return { mode, uid, gid };
}

async function remoteHash(
  conn: Client,
  path: string,
  elevate: boolean,
  context: RemoteToolContext,
): Promise<string | undefined> {
  const command =
    "if [ -f " +
    quoteShell(path) +
    " ]; then sha256sum -- " +
    quoteShell(path) +
    " | cut -d ' ' -f 1; else printf __MISSING__; fi";
  const result = await checkedCommand(
    conn,
    commandForElevation(command, elevate, context),
    "hash",
  );
  const value = result.stdout.toString("utf8").trim();
  return value === "__MISSING__" ? undefined : value;
}

async function ensureParentDirectory(
  conn: Client,
  parent: string,
  createDirs: boolean,
  elevate: boolean,
  context: RemoteToolContext,
): Promise<boolean> {
  const exists = await execCommand(
    conn,
    commandForElevation("test -d " + quoteShell(parent), elevate, context),
  );
  if (exists.exitCode === 0) return false;
  if (!createDirs) {
    throw new RemoteToolError(
      "parent",
      "Parent directory does not exist; retry with create_dirs: true",
      { parent },
    );
  }
  await checkedCommand(
    conn,
    commandForElevation("mkdir -p -- " + quoteShell(parent), elevate, context),
    "parent",
  );
  return true;
}

async function ensureStagingDirectory(
  conn: Client,
  root: string,
  elevate: boolean,
  context: RemoteToolContext,
): Promise<void> {
  const regular = await execCommand(conn, "mkdir -p -- " + quoteShell(root));
  if (regular.exitCode === 0) {
    await checkedCommand(conn, "chmod 700 -- " + quoteShell(root), "staging");
    return;
  }
  if (!elevate) {
    throw new RemoteToolError("staging", "Unable to create remote staging directory");
  }
  const username = context.sshConfig.username;
  const command =
    "install -d -m 0700 -o " +
    quoteShell(username) +
    " -- " +
    quoteShell(root);
  await checkedCommand(
    conn,
    commandForElevation(command, true, context),
    "staging",
  );
}

function contentBuffer(options: RemoteWriteOptions): Buffer {
  const hasText = options.content !== undefined;
  const hasBase64 = options.contentBase64 !== undefined;
  if (hasText === hasBase64) {
    throw new RemoteToolError(
      "input",
      "Provide exactly one of content or content_base64",
    );
  }
  if (hasBase64) {
    const normalized = options.contentBase64?.replace(/\s+/g, "") ?? "";
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      throw new RemoteToolError("input", "content_base64 is not valid base64");
    }
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
      throw new RemoteToolError("input", "content_base64 is not canonical base64");
    }
    if (decoded.length > MAX_REMOTE_FILE_BYTES) {
      throw new RemoteToolError("input", "Decoded content exceeds 8 MiB");
    }
    return decoded;
  }

  const text = options.normalizeNewlines === false
    ? options.content ?? ""
    : (options.content ?? "").replace(/\r\n/g, "\n");
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length > MAX_REMOTE_FILE_BYTES) {
    throw new RemoteToolError("input", "Content exceeds 8 MiB");
  }
  return encoded;
}

async function writeBuffer(
  conn: Client,
  context: RemoteToolContext,
  options: RemoteWriteOptions,
  buffer: Buffer,
): Promise<Record<string, unknown>> {
  const elevate = options.elevate === true;
  const targetPath = await canonicalizePath(conn, options.path, context);
  const parent = pathPosix.dirname(targetPath);
  const createdParent = await ensureParentDirectory(
    conn,
    parent,
    options.createDirs === true,
    elevate,
    context,
  );
  const currentHash = await remoteHash(conn, targetPath, elevate, context);
  const nextHash = sha256(buffer);

  if (currentHash === nextHash) {
    return {
      path: targetPath,
      bytes_written: 0,
      sha256: nextHash,
      unchanged: true,
      ...(createdParent ? { created_dirs: [parent] } : {}),
    };
  }
  if (options.expectedSha256 && currentHash !== options.expectedSha256) {
    throw new RemoteToolError(
      "conflict",
      "expected_sha256 does not match the current remote file; read it again before writing",
      { expected_sha256: options.expectedSha256, actual_sha256: currentHash ?? null },
    );
  }

  const currentMetadata = currentHash
    ? await remoteFileMetadata(conn, targetPath, elevate, context)
    : undefined;
  const mode = options.mode ?? currentMetadata?.mode ?? "0644";
  assertMode(mode);
  const owner = parseOwner(
    options.owner ??
      (currentMetadata
        ? currentMetadata.uid + ":" + currentMetadata.gid
        : elevate
          ? "root:root"
          : context.sshConfig.username),
  );
  const stagingRoot = remoteWorkspaceRoot(context, "staging");
  await ensureStagingDirectory(conn, stagingRoot, elevate, context);
  const stagingPath = stagingRoot + "/" + randomUUID();
  const targetStagingPath = pathPosix.join(
    parent,
    "." + pathPosix.basename(targetPath) + ".mcp-" + randomUUID(),
  );
  const sftp = await openSftp(conn);
  await sftpWriteFile(sftp, stagingPath, buffer);

  const backupEnabled = options.backup !== false;
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const backupPath = targetPath + ".bak." + timestamp;
  try {
    if (currentHash && backupEnabled) {
      await checkedCommand(
        conn,
        commandForElevation(
          "cp -a -- " + quoteShell(targetPath) + " " + quoteShell(backupPath),
          elevate,
          context,
        ),
        "backup",
      );
    }

    let install =
      "install -m " +
      quoteShell(mode) +
      " -o " +
      quoteShell(owner.user);
    if (owner.group) install += " -g " + quoteShell(owner.group);
    install += " -- " + quoteShell(stagingPath) + " " + quoteShell(targetStagingPath);
    const publish =
      install +
      " && mv -f -- " +
      quoteShell(targetStagingPath) +
      " " +
      quoteShell(targetPath);
    await checkedCommand(
      conn,
      commandForElevation(publish, elevate, context),
      "install",
    );

    const actualHash = await remoteHash(conn, targetPath, elevate, context);
    if (options.verify === true && actualHash !== nextHash) {
      throw new RemoteToolError("verify", "Remote verification hash does not match uploaded content", {
        expected_sha256: nextHash,
        actual_sha256: actualHash ?? null,
      });
    }

    return {
      path: targetPath,
      bytes_written: buffer.length,
      sha256: actualHash ?? nextHash,
      ...(currentHash && backupEnabled ? { backup_path: backupPath } : {}),
      ...(createdParent ? { created_dirs: [parent] } : {}),
    };
  } finally {
    await sftpUnlink(sftp, stagingPath);
    await execCommand(
      conn,
      commandForElevation("rm -f -- " + quoteShell(targetStagingPath), elevate, context),
    ).catch(() => undefined);
  }
}

export async function readRemoteFile(
  context: RemoteToolContext,
  options: RemoteReadOptions,
): Promise<Record<string, unknown>> {
  const offset = options.offset ?? 1;
  const limit = options.limit ?? 2000;
  if (!Number.isInteger(offset) || offset < 1) {
    throw new RemoteToolError("input", "offset must be a positive 1-based line number");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) {
    throw new RemoteToolError("input", "limit must be between 1 and 20000");
  }

  return withClient(context.sshConfig, async (conn) => {
    const path = await canonicalizePath(conn, options.path, context);
    const buffer = await readBuffer(conn, path, options.elevate === true, context);
    const text = buffer.toString("utf8").replace(/\r\n/g, "\n");
    const lines = text.length === 0 ? [] : text.split("\n");
    if (lines.length && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const content = selected
      .map((line, index) => String(offset + index).padStart(6, " ") + "\t" + line)
      .join("\n");
    return {
      path,
      content,
      total_lines: lines.length,
      truncated: offset - 1 + selected.length < lines.length,
      sha256: sha256(buffer),
    };
  });
}

export async function writeRemoteFile(
  context: RemoteToolContext,
  options: RemoteWriteOptions,
): Promise<Record<string, unknown>> {
  const buffer = contentBuffer(options);
  return withClient(context.sshConfig, (conn) => writeBuffer(conn, context, options, buffer));
}

function occurrenceOffsets(content: string, needle: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) break;
    offsets.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return offsets;
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function candidateLines(content: string, needle: string): Array<{ line: number; content: string }> {
  const terms = needle.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  return content
    .split("\n")
    .map((line, index) => ({
      line: index + 1,
      content: line,
      score: terms.reduce((score, term) => score + (line.toLowerCase().includes(term) ? term.length : 0), 0),
    }))
    .sort((left, right) => right.score - left.score || left.line - right.line)
    .slice(0, 3)
    .map(({ line, content: lineContent }) => ({ line, content: lineContent }));
}

export async function editRemoteFile(
  context: RemoteToolContext,
  options: RemoteEditOptions,
): Promise<Record<string, unknown>> {
  if (!options.oldString) {
    throw new RemoteToolError("input", "old_string must be non-empty");
  }

  return withClient(context.sshConfig, async (conn) => {
    const path = await canonicalizePath(conn, options.path, context);
    const buffer = await readBuffer(conn, path, options.elevate === true, context);
    const currentHash = sha256(buffer);
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) {
      throw new RemoteToolError("encoding", "fs-edit only supports UTF-8 text files; use fs-write content_base64");
    }

    const offsets = occurrenceOffsets(text, options.oldString);
    if (offsets.length === 0) {
      const candidates = candidateLines(text, options.oldString);
      const preview = candidates.map((entry) => String(entry.line) + ": " + entry.content).join("\n");
      throw new RemoteToolError(
        "match",
        "old_string was not found. Closest lines:\n" + preview,
        { matches: 0, candidate_lines: candidates },
      );
    }
    if (offsets.length > 1 && options.replaceAll !== true) {
      const lines = offsets.map((offset) => lineNumberAt(text, offset));
      throw new RemoteToolError(
        "match",
        "old_string matched multiple locations at lines " +
          lines.join(", ") +
          "; provide more context or set replace_all: true",
        { matches: offsets.length, lines },
      );
    }

    const replacements = options.replaceAll === true ? offsets.length : 1;
    const updated = options.replaceAll === true
      ? text.split(options.oldString).join(options.newString)
      : text.replace(options.oldString, options.newString);
    const result = await writeBuffer(
      conn,
      context,
      {
        path,
        content: updated,
        expectedSha256: currentHash,
        elevate: options.elevate,
        backup: options.backup,
        normalizeNewlines: false,
        verify: true,
      },
      Buffer.from(updated, "utf8"),
    );
    return { ...result, replacements };
  });
}

function syntaxCommand(interpreter: ScriptInterpreter, path: string): string {
  if (interpreter === "python3") {
    return (
      "python3 -c " +
      quoteShell(
        "import ast, pathlib; ast.parse(pathlib.Path(" +
        JSON.stringify(path) +
        ").read_text(encoding='utf-8'))",
      )
    );
  }
  if (interpreter === "node") return "node --check " + quoteShell(path);
  return interpreter + " -n " + quoteShell(path);
}

function validateEnvironment(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new RemoteToolError("input", "Invalid environment variable name: " + key);
    }
    if (typeof value !== "string") {
      throw new RemoteToolError("input", "Environment values must be strings");
    }
  }
}

export async function prepareRemoteScript(
  context: RemoteToolContext,
  options: PrepareScriptOptions,
): Promise<PreparedScript> {
  const hasContent = options.content !== undefined;
  const hasPath = options.path !== undefined;
  if (hasContent === hasPath) {
    throw new RemoteToolError("input", "Provide exactly one of content or path");
  }

  const interpreter = options.interpreter ?? "bash";
  if (!["bash", "sh", "python3", "node"].includes(interpreter)) {
    throw new RemoteToolError("input", "Unsupported interpreter");
  }
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new RemoteToolError("input", "args must be an array of strings");
  }
  const env = options.env ?? {};
  validateEnvironment(env);

  return withClient(context.sshConfig, async (conn) => {
    const elevate = options.elevate === true;
    let scriptPath: string;
    let staged = false;
    let sftp: SFTPWrapper | undefined;

    if (hasContent) {
      const normalized = (options.content ?? "").replace(/\r\n/g, "\n");
      const buffer = Buffer.from(normalized, "utf8");
      if (buffer.length > MAX_REMOTE_FILE_BYTES) {
        throw new RemoteToolError("input", "Script content exceeds 8 MiB");
      }
      await ensureStagingDirectory(conn, remoteWorkspaceRoot(context, "scripts"), elevate, context);
      const extension = interpreter === "python3" ? ".py" : interpreter === "node" ? ".js" : ".sh";
      scriptPath = remoteWorkspaceRoot(context, "scripts") + "/" + randomUUID() + extension;
      sftp = await openSftp(conn);
      await sftpWriteFile(sftp, scriptPath, buffer);
      staged = true;
    } else {
      scriptPath = await canonicalizePath(conn, options.path ?? "", context);
    }

    try {
      if (options.checkSyntax !== false) {
        const syntax = await execCommand(
          conn,
          commandForElevation(syntaxCommand(interpreter, scriptPath), elevate, context),
        );
        if (syntax.exitCode !== 0 || syntax.signal) {
          const detail = (syntax.stderr.length ? syntax.stderr : syntax.stdout).toString("utf8").trim();
          throw new RemoteToolError("syntax", detail || "Script syntax check failed", {
            exit_code: syntax.exitCode,
            signal: syntax.signal,
          });
        }
      }

      const cwd = options.cwd
        ? await canonicalizePath(conn, options.cwd, context)
        : undefined;
      const envArgs = Object.entries(env).map(([key, value]) => key + "=" + quoteShell(value));
      const commandParts = [
        ...(cwd ? ["cd " + quoteShell(cwd) + " &&"] : []),
        ...(envArgs.length ? ["env", ...envArgs] : []),
        interpreter,
        quoteShell(scriptPath),
        ...args.map(quoteShell),
      ];
      let command = commandParts.join(" ");
      if (staged) {
        command =
          "trap " +
          quoteShell("rm -f -- " + quoteShell(scriptPath)) +
          " EXIT; " +
          command;
      }
      command = commandForElevation(command, elevate, context);
      return {
        command,
        commandLength: hasContent ? (options.content ?? "").length : command.length,
        stdin: options.stdin,
        timeoutMs: options.timeoutMs,
        cleanup: staged
          ? async () => {
              await withClient(context.sshConfig, async (cleanupConn) => {
                await checkedCommand(
                  cleanupConn,
                  commandForElevation("rm -f -- " + quoteShell(scriptPath), elevate, context),
                  "cleanup",
                );
              });
            }
          : undefined,
      };
    } catch (error) {
      if (staged && sftp) await sftpUnlink(sftp, scriptPath);
      throw error;
    }
  });
}
