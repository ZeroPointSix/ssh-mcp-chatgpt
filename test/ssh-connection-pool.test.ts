import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import type { SSHConfig } from "../src/index.js";
import { SshConnectionPool } from "../src/ssh-connection-pool.js";

class FakeClient extends EventEmitter {
  ended = false;
  endCalls = 0;

  constructor(private readonly autoReady = true) {
    super();
  }

  connect(): void {
    if (this.autoReady) queueMicrotask(() => this.emit("ready"));
  }

  end(): void {
    this.endCalls += 1;
    this.ended = true;
    this.emit("close");
  }
}

const config: SSHConfig = {
  host: "example.test",
  port: 22,
  username: "tester",
  password: "secret",
};

function fakeFactory(clients: FakeClient[], autoReady = true): () => Client {
  return () => {
    const client = new FakeClient(autoReady);
    clients.push(client);
    return client as unknown as Client;
  };
}

describe("SshConnectionPool", () => {
  it("reuses an idle connection for the same target", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(2, 2, 1_000, 60_000, fakeFactory(clients));

    const first = await pool.acquire(config);
    const firstClient = first.client;
    first.release();

    const second = await pool.acquire(config);
    expect(second.client).toBe(firstClient);
    expect(pool.status()).toMatchObject({
      targets: 1,
      connections: 1,
      active_leases: 1,
      created_total: 1,
    });

    second.release();
    pool.closeAll();
  });

  it("caps connections and queues until channel capacity is released", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(2, 2, 1_000, 60_000, fakeFactory(clients));

    const leases = await Promise.all([
      pool.acquire(config),
      pool.acquire(config),
      pool.acquire(config),
      pool.acquire(config),
    ]);
    expect(pool.status()).toMatchObject({
      connections: 2,
      active_leases: 4,
      created_total: 2,
    });

    const pending = pool.acquire(config);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pool.status().waiting_acquires).toBe(1);

    leases[0].release();
    const queued = await pending;
    expect(pool.status()).toMatchObject({
      connections: 2,
      active_leases: 4,
      waiting_acquires: 0,
    });

    queued.release();
    leases.slice(1).forEach((lease) => lease.release());
    pool.closeAll();
  });

  it("replaces a connection released as unhealthy", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(1, 1, 1_000, 60_000, fakeFactory(clients));

    const first = await pool.acquire(config);
    const failedClient = first.client;
    first.release(true);

    const second = await pool.acquire(config);
    expect(second.client).not.toBe(failedClient);
    expect(clients[0].ended).toBe(true);
    expect(pool.status()).toMatchObject({
      connections: 1,
      created_total: 2,
    });

    second.release();
    pool.closeAll();
  });

  it("ends an unhealthy shared transport only once", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(1, 2, 1_000, 60_000, fakeFactory(clients));

    const first = await pool.acquire(config);
    const second = await pool.acquire(config);
    first.release(true);
    second.release(true);

    expect(clients[0].endCalls).toBe(1);
    pool.closeAll();
  });


  it("times out while waiting for channel capacity", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(1, 1, 20, 60_000, fakeFactory(clients));

    const first = await pool.acquire(config);
    await expect(pool.acquire(config)).rejects.toThrow(
      "SSH connection pool acquire timed out after 20ms",
    );

    first.release();
    pool.closeAll();
  });

  it("reclaims an expired idle connection", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(1, 1, 1_000, 10, fakeFactory(clients));

    const lease = await pool.acquire(config);
    lease.release();
    (pool as any).closeExpiredIdleConnections(Date.now() + 11);

    expect(clients[0].ended).toBe(true);
    expect(pool.status()).toMatchObject({
      connections: 0,
      idle_connections: 0,
    });
    pool.closeAll();
  });

  it("ends a transport that errors before SSH is ready", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(
      1,
      1,
      1_000,
      60_000,
      fakeFactory(clients, false),
    );

    const pending = pool.acquire(config);
    clients[0].emit("error", new Error("handshake failed"));

    await expect(pending).rejects.toThrow("handshake failed");
    expect(clients[0].endCalls).toBe(1);
    pool.closeAll();
  });

  it("rejects when the transport closes before SSH is ready", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(
      1,
      1,
      1_000,
      60_000,
      fakeFactory(clients, false),
    );

    const pending = pool.acquire(config);
    clients[0].emit("close");

    await expect(pending).rejects.toThrow("SSH connection closed before ready");
    expect(pool.status()).toMatchObject({
      connections: 0,
      created_total: 0,
    });
    pool.closeAll();
  });

  it("rejects all acquires sharing a failed handshake and allows a retry", async () => {
    const clients: FakeClient[] = [];
    let attempt = 0;
    const pool = new SshConnectionPool(1, 1, 1_000, 60_000, () => {
      const client = new FakeClient(attempt++ > 0);
      clients.push(client);
      return client as unknown as Client;
    });

    const first = pool.acquire(config);
    const second = pool.acquire(config);
    expect(clients).toHaveLength(1);

    clients[0].emit("close");
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(Error);
        expect(result.reason.message).toBe("SSH connection closed before ready");
      }
    }

    const recovered = await pool.acquire(config);
    expect(clients).toHaveLength(2);
    expect(recovered.client).toBe(clients[1]);
    expect(pool.status()).toMatchObject({
      connections: 1,
      active_leases: 1,
      created_total: 1,
    });

    recovered.release();
    pool.closeAll();
  });

  it("evicts a ready connection immediately when its transport closes", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(1, 1, 1_000, 60_000, fakeFactory(clients));

    const first = await pool.acquire(config);
    const failedClient = first.client;
    clients[0].emit("close");

    expect(pool.status()).toMatchObject({
      connections: 0,
      active_leases: 0,
    });
    expect(clients[0].ended).toBe(false);

    first.release(true);
    expect(clients[0].endCalls).toBe(0);
    const recovered = await pool.acquire(config);
    expect(recovered.client).not.toBe(failedClient);
    expect(clients).toHaveLength(2);

    recovered.release();
    pool.closeAll();
  });

  it("isolates a short waiter timeout from a shared handshake", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(
      1,
      1,
      1_000,
      60_000,
      fakeFactory(clients, false),
    );

    const shortWaiter = pool.acquire(config, { timeoutMs: 20 });
    const longWaiter = pool.acquire(config, { timeoutMs: 500 });
    await expect(shortWaiter).rejects.toThrow(
      "SSH connection pool acquire timed out after 20ms",
    );
    expect(clients[0].ended).toBe(false);

    clients[0].emit("ready");
    const recovered = await longWaiter;
    expect(recovered.client).toBe(clients[0]);

    recovered.release();
    pool.closeAll();
  });

  it("isolates one waiter abort from a shared handshake", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(
      1,
      1,
      1_000,
      60_000,
      fakeFactory(clients, false),
    );
    const controller = new AbortController();

    const abortedWaiter = pool.acquire(config, { signal: controller.signal });
    const activeWaiter = pool.acquire(config, { timeoutMs: 500 });
    controller.abort();

    await expect(abortedWaiter).rejects.toThrow("SSH connection acquire aborted");
    expect(clients[0].ended).toBe(false);

    clients[0].emit("ready");
    const recovered = await activeWaiter;
    expect(recovered.client).toBe(clients[0]);

    recovered.release();
    pool.closeAll();
  });

  it("times out a slow handshake before the pool default wait elapses", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(
      1,
      1,
      5_000,
      60_000,
      fakeFactory(clients, false),
    );

    const started = Date.now();
    await expect(pool.acquire(config, { timeoutMs: 30 })).rejects.toThrow(
      "SSH connection pool acquire timed out after 30ms",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pool.status()).toMatchObject({
      connections: 0,
      waiting_acquires: 0,
      created_total: 0,
    });
    pool.closeAll();
  });

  it("aborts a pending acquire when the signal fires", async () => {
    const clients: FakeClient[] = [];
    const pool = new SshConnectionPool(
      1,
      1,
      5_000,
      60_000,
      fakeFactory(clients, false),
    );
    const controller = new AbortController();
    const pending = pool.acquire(config, { signal: controller.signal });
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toThrow("SSH connection acquire aborted");
    expect(pool.status().waiting_acquires).toBe(0);
    expect(clients[0].endCalls).toBe(1);
    clients[0].emit("error", new Error("late handshake error"));
    expect(clients[0].endCalls).toBe(1);
    pool.closeAll();
  });
});
