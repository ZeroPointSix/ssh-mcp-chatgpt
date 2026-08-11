import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { SSHConfig } from "./index.js";

interface PoolEntry {
  client: Client;
  activeLeases: number;
  lastUsedAt: number;
  dead: boolean;
}

export interface SshConnectionLease {
  client: Client;
  release: (unhealthy?: boolean) => void;
}

export interface SshConnectionAcquireOptions {
  /** Hard deadline for the whole acquire path, including handshake and capacity wait. */
  timeoutMs?: number;
  /** Optional cancellation signal that aborts a pending acquire. */
  signal?: AbortSignal;
}

export interface SshConnectionPoolStatus {
  targets: number;
  connections: number;
  active_leases: number;
  idle_connections: number;
  waiting_acquires: number;
  created_total: number;
  max_connections_per_target: number;
  max_channels_per_connection: number;
}

export class SshConnectionAcquireError extends Error {
  constructor(
    message: string,
    public readonly code: "TIMEOUT" | "ABORTED" | "CONNECT_FAILED" = "CONNECT_FAILED",
  ) {
    super(message);
    this.name = "SshConnectionAcquireError";
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configKey(config: SSHConfig): string {
  const credentialHash = createHash("sha256")
    .update(config.password ?? "")
    .update("\0")
    .update(config.privateKey ?? "")
    .digest("hex");
  return JSON.stringify({
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: config.readyTimeout,
    credentialHash,
  });
}

type CreationResult =
  | { ok: true; entry: PoolEntry }
  | { ok: false; error: Error };

interface InflightCreation {
  promise: Promise<CreationResult>;
  client: Client;
  abort: () => void;
  waiters: number;
}

export class SshConnectionPool {
  private readonly entries = new Map<string, PoolEntry[]>();
  private readonly creating = new Map<string, InflightCreation>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly idleTimer: NodeJS.Timeout;
  private createdTotal = 0;

  constructor(
    private readonly maxConnectionsPerTarget = positiveIntegerEnv(
      "SSH_MCP_POOL_MAX_CONNECTIONS_PER_TARGET",
      2,
    ),
    private readonly maxChannelsPerConnection = positiveIntegerEnv(
      "SSH_MCP_POOL_MAX_CHANNELS_PER_CONNECTION",
      4,
    ),
    private readonly acquireTimeoutMs = positiveIntegerEnv(
      "SSH_MCP_POOL_ACQUIRE_TIMEOUT_MS",
      30_000,
    ),
    private readonly idleTimeoutMs = positiveIntegerEnv(
      "SSH_MCP_POOL_IDLE_TIMEOUT_MS",
      60_000,
    ),
    private readonly clientFactory: () => Client = () => new Client(),
  ) {
    this.idleTimer = setInterval(
      () => this.closeExpiredIdleConnections(),
      Math.min(this.idleTimeoutMs, 30_000),
    );
    this.idleTimer.unref?.();
  }

  async acquire(
    config: SSHConfig,
    options: SshConnectionAcquireOptions = {},
  ): Promise<SshConnectionLease> {
    const key = configKey(config);
    const startedAt = Date.now();
    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : this.acquireTimeoutMs;
    const deadlineAt = startedAt + timeoutMs;
    const signal = options.signal;

    if (signal?.aborted) {
      throw new SshConnectionAcquireError("SSH connection acquire aborted", "ABORTED");
    }

    while (true) {
      this.throwIfAcquireExpired(deadlineAt, timeoutMs, signal);

      const entry = this.findAvailableEntry(key);
      if (entry) return this.lease(key, entry);

      const currentEntries = this.liveEntries(key);
      let creation = this.creating.get(key);
      if (!creation && currentEntries.length < this.maxConnectionsPerTarget) {
        creation = this.createEntry(key, config);
        this.creating.set(key, creation);
        // Keep the in-flight marker until the handshake settles, even if a
        // waiter times out earlier. That prevents duplicate handshakes.
        void creation.promise.finally(() => {
          if (this.creating.get(key) === creation) this.creating.delete(key);
        });
      }

      if (creation) {
        let result: CreationResult | undefined;
        let waiterExpired = false;
        creation.waiters += 1;
        try {
          // Shared waiters must observe the same handshake failure. TIMEOUT and
          // ABORTED still reject only the timed-out waiter.
          result = await this.awaitWithDeadline(
            creation.promise,
            deadlineAt,
            timeoutMs,
            signal,
          );
        } catch (error) {
          if (
            error instanceof SshConnectionAcquireError &&
            (error.code === "TIMEOUT" || error.code === "ABORTED")
          ) {
            waiterExpired = true;
          }
          throw error;
        } finally {
          creation.waiters = Math.max(0, creation.waiters - 1);
          // A caller owns only its wait. Abort the shared handshake only when
          // no other acquire can still use it.
          if (waiterExpired && creation.waiters === 0) creation.abort();
        }
        if (result && !result.ok) {
          throw result.error;
        }
        continue;
      }

      await this.waitForCapacity(key, deadlineAt, timeoutMs, signal);
    }
  }

  status(): SshConnectionPoolStatus {
    let connections = 0;
    let activeLeases = 0;
    let idleConnections = 0;
    for (const entries of this.entries.values()) {
      for (const entry of entries) {
        if (entry.dead) continue;
        connections += 1;
        activeLeases += entry.activeLeases;
        if (entry.activeLeases === 0) idleConnections += 1;
      }
    }
    return {
      targets: [...this.entries.values()].filter((entries) =>
        entries.some((entry) => !entry.dead),
      ).length,
      connections,
      active_leases: activeLeases,
      idle_connections: idleConnections,
      waiting_acquires: [...this.waiters.values()].reduce(
        (total, waiters) => total + waiters.size,
        0,
      ),
      created_total: this.createdTotal,
      max_connections_per_target: this.maxConnectionsPerTarget,
      max_channels_per_connection: this.maxChannelsPerConnection,
    };
  }

  closeAll(): void {
    clearInterval(this.idleTimer);
    for (const entries of this.entries.values()) {
      for (const entry of entries) this.destroyEntry(entry);
    }
    this.entries.clear();
  }

  private liveEntries(key: string): PoolEntry[] {
    const entries = (this.entries.get(key) ?? []).filter((entry) => !entry.dead);
    if (entries.length > 0) this.entries.set(key, entries);
    else this.entries.delete(key);
    return entries;
  }

  private findAvailableEntry(key: string): PoolEntry | undefined {
    return this.liveEntries(key)
      .filter((entry) => entry.activeLeases < this.maxChannelsPerConnection)
      .sort((left, right) => left.activeLeases - right.activeLeases)[0];
  }

  private lease(key: string, entry: PoolEntry): SshConnectionLease {
    entry.activeLeases += 1;
    let released = false;
    return {
      client: entry.client,
      release: (unhealthy = false) => {
        if (released) return;
        released = true;
        entry.activeLeases = Math.max(0, entry.activeLeases - 1);
        entry.lastUsedAt = Date.now();
        if (unhealthy) this.destroyEntry(entry);
        this.wakeOne(key);
      },
    };
  }

  private createEntry(key: string, config: SSHConfig): InflightCreation {
    const client = this.clientFactory();
    let settled = false;
    let aborted = false;
    let resolveCreation!: (result: CreationResult) => void;
    const entry: PoolEntry = {
      client,
      activeLeases: 0,
      lastUsedAt: Date.now(),
      dead: false,
    };

    // Always resolve (never reject) so late handshake failures cannot surface as
    // unhandledRejection after waiters already timed out.
    const promise = new Promise<CreationResult>((resolve) => {
      resolveCreation = resolve;
    });

    const fail = (error: Error) => {
      entry.dead = true;
      if (settled) {
        this.destroyEntry(entry);
        this.wakeOne(key);
        return;
      }
      settled = true;
      resolveCreation({ ok: false, error });
      this.wakeOne(key);
    };

    client.once("ready", () => {
      if (settled || aborted) return;
      settled = true;
      this.createdTotal += 1;
      const entries = this.entries.get(key) ?? [];
      entries.push(entry);
      this.entries.set(key, entries);
      resolveCreation({ ok: true, entry });
    });
    client.on("error", (error: Error) => {
      fail(error);
    });
    client.on("close", () => {
      fail(new Error("SSH connection closed before ready"));
    });
    try {
      client.connect(config);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }

    return {
      promise,
      client,
      waiters: 0,
      abort: () => {
        if (settled || aborted) return;
        aborted = true;
        settled = true;
        entry.dead = true;
        if (this.creating.get(key)?.client === client) this.creating.delete(key);
        resolveCreation({
          ok: false,
          error: new Error("SSH connection handshake aborted"),
        });
        try {
          client.end();
        } catch {
          /* ignore */
        }
        this.wakeOne(key);
      },
    };
  }

  private remainingMs(deadlineAt: number): number {
    return Math.max(0, deadlineAt - Date.now());
  }

  private throwIfAcquireExpired(
    deadlineAt: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted) {
      throw new SshConnectionAcquireError("SSH connection acquire aborted", "ABORTED");
    }
    if (Date.now() >= deadlineAt) {
      throw new SshConnectionAcquireError(
        `SSH connection pool acquire timed out after ${timeoutMs}ms`,
        "TIMEOUT",
      );
    }
  }

  private awaitWithDeadline<T>(
    promise: Promise<T>,
    deadlineAt: number,
    timeoutMs: number,
    signal?: AbortSignal,
    mode: "propagate-errors" | "ignore-errors" = "propagate-errors",
  ): Promise<T | undefined> {
    this.throwIfAcquireExpired(deadlineAt, timeoutMs, signal);
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finishResolve = (value?: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        finishReject(new SshConnectionAcquireError("SSH connection acquire aborted", "ABORTED"));
      };
      const timer = setTimeout(() => {
        finishReject(
          new SshConnectionAcquireError(
            `SSH connection pool acquire timed out after ${timeoutMs}ms`,
            "TIMEOUT",
          ),
        );
      }, this.remainingMs(deadlineAt));
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });

      promise.then(
        (value) => finishResolve(value),
        (error) => {
          if (mode === "ignore-errors") finishResolve(undefined);
          else finishReject(error);
        },
      );
    });
  }

  private waitForCapacity(
    key: string,
    deadlineAt: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfAcquireExpired(deadlineAt, timeoutMs, signal);
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(key) ?? new Set<() => void>();
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(wake);
        if (waiters.size === 0) this.waiters.delete(key);
      };
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const wake = () => finishResolve();
      const onAbort = () => {
        finishReject(new SshConnectionAcquireError("SSH connection acquire aborted", "ABORTED"));
      };
      waiters.add(wake);
      this.waiters.set(key, waiters);
      const timer = setTimeout(() => {
        finishReject(
          new SshConnectionAcquireError(
            `SSH connection pool acquire timed out after ${timeoutMs}ms`,
            "TIMEOUT",
          ),
        );
      }, this.remainingMs(deadlineAt));
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wakeOne(key: string): void {
    const wake = this.waiters.get(key)?.values().next().value;
    if (wake) wake();
  }

  private closeExpiredIdleConnections(now = Date.now()): void {
    for (const [key, entries] of this.entries) {
      for (const entry of entries) {
        if (
          !entry.dead &&
          entry.activeLeases === 0 &&
          now - entry.lastUsedAt >= this.idleTimeoutMs
        ) {
          this.destroyEntry(entry);
        }
      }
      this.liveEntries(key);
    }
  }

  private destroyEntry(entry: PoolEntry): void {
    entry.dead = true;
    try {
      entry.client.end();
    } catch {
      // Ignore cleanup errors from an already failed transport.
    }
  }
}

export const sshConnectionPool = new SshConnectionPool();

export function acquireSshConnection(
  config: SSHConfig,
  options?: SshConnectionAcquireOptions,
): Promise<SshConnectionLease> {
  return sshConnectionPool.acquire(config, options);
}

export async function withSshConnection<T>(
  config: SSHConfig,
  callback: (client: Client) => Promise<T>,
  options?: SshConnectionAcquireOptions,
): Promise<T> {
  const lease = await acquireSshConnection(config, options);
  try {
    return await callback(lease.client);
  } finally {
    lease.release();
  }
}
