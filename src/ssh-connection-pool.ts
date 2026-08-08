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

export class SshConnectionPool {
  private readonly entries = new Map<string, PoolEntry[]>();
  private readonly creating = new Map<string, Promise<PoolEntry>>();
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
      8,
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

  async acquire(config: SSHConfig): Promise<SshConnectionLease> {
    const key = configKey(config);
    while (true) {
      const entry = this.findAvailableEntry(key);
      if (entry) return this.lease(key, entry);

      const currentEntries = this.liveEntries(key);
      const inFlight = this.creating.get(key);
      if (inFlight) {
        await inFlight;
        continue;
      }

      if (currentEntries.length < this.maxConnectionsPerTarget) {
        const creation = this.createEntry(key, config);
        this.creating.set(key, creation);
        try {
          await creation;
        } finally {
          if (this.creating.get(key) === creation) this.creating.delete(key);
        }
        continue;
      }
      await this.waitForCapacity(key);
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

  private createEntry(key: string, config: SSHConfig): Promise<PoolEntry> {
    return new Promise((resolve, reject) => {
      const client = this.clientFactory();
      const entry: PoolEntry = {
        client,
        activeLeases: 0,
        lastUsedAt: Date.now(),
        dead: false,
      };
      let settled = false;
      client.once("ready", () => {
        if (settled) return;
        settled = true;
        this.createdTotal += 1;
        const entries = this.entries.get(key) ?? [];
        entries.push(entry);
        this.entries.set(key, entries);
        resolve(entry);
      });
      client.on("error", (error: Error) => {
        entry.dead = true;
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.wakeOne(key);
      });
      client.on("close", () => {
        entry.dead = true;
        this.wakeOne(key);
      });
      client.connect(config);
    });
  }

  private waitForCapacity(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(key) ?? new Set<() => void>();
      let timer: NodeJS.Timeout;
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0) this.waiters.delete(key);
        resolve();
      };
      waiters.add(wake);
      this.waiters.set(key, waiters);
      timer = setTimeout(() => {
        waiters.delete(wake);
        if (waiters.size === 0) this.waiters.delete(key);
        reject(new Error(\`SSH connection pool acquire timed out after \${this.acquireTimeoutMs}ms\`));
      }, this.acquireTimeoutMs);
      timer.unref?.();
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

export function acquireSshConnection(config: SSHConfig): Promise<SshConnectionLease> {
  return sshConnectionPool.acquire(config);
}

export async function withSshConnection<T>(
  config: SSHConfig,
  callback: (client: Client) => Promise<T>,
): Promise<T> {
  const lease = await acquireSshConnection(config);
  try {
    return await callback(lease.client);
  } finally {
    lease.release();
  }
}
