import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import type { SSHConfig } from "../src/index.js";
import { SshConnectionPool } from "../src/ssh-connection-pool.js";

class FakeClient extends EventEmitter {
  ended = false;

  connect(): void {
    queueMicrotask(() => this.emit("ready"));
  }

  end(): void {
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

function fakeFactory(clients: FakeClient[]): () => Client {
  return () => {
    const client = new FakeClient();
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
});
