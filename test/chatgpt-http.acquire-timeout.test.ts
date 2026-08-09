import { afterEach, describe, expect, it, vi } from "vitest";

const poolMock = vi.hoisted(() => ({
  acquire: vi.fn(),
  status: vi.fn(() => ({
    targets: 0,
    connections: 0,
    active_leases: 0,
    idle_connections: 0,
    waiting_acquires: 0,
    created_total: 0,
    max_connections_per_target: 2,
    max_channels_per_connection: 4,
  })),
  closeAll: vi.fn(),
}));

vi.mock("../src/ssh-connection-pool.js", () => ({
  sshConnectionPool: {
    status: () => poolMock.status(),
    closeAll: () => poolMock.closeAll(),
  },
  acquireSshConnection: (config: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    poolMock.acquire(config, options),
  withSshConnection: async () => {
    throw new Error("not used in this test");
  },
}));

import { invokeTool, loadRuntimeConfig } from "../src/chatgpt-http.js";

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  poolMock.acquire.mockReset();
  restoreEnv();
});

describe("ChatGPT HTTP acquire timeout contract", () => {
  it("returns a job_id within expire_time_ms while pool acquire is still pending", async () => {
    process.env.SSH_MCP_HOST = "10.0.0.9";
    process.env.SSH_MCP_PORT = "22";
    process.env.SSH_MCP_USER = "tester";
    process.env.SSH_MCP_PASSWORD = "secret";
    process.env.SSH_MCP_DISABLE_SUDO = "1";
    process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = "0";

    poolMock.acquire.mockImplementation(
      (_config: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("SSH connection pool acquire timed out after 80ms"));
          }, options.timeoutMs ?? 30_000);
          timer.unref?.();
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("SSH connection acquire aborted"));
            },
            { once: true },
          );
        }),
    );

    const config = loadRuntimeConfig();
    const startedAt = Date.now();
    const result = await invokeTool(
      "exec",
      {
        command: "printf hang",
        expire_time_ms: 80,
        kill_time_ms: 5_000,
        note: "verify expire covers pool acquire wait",
      },
      "test-session",
      config,
    );
    const elapsed = Date.now() - startedAt;

    // Critical contract: caller is not blocked for the full pool default (30s).
    expect(elapsed).toBeLessThan(1_000);
    expect(result.job_id).toMatch(/^job-/);
    expect(poolMock.acquire).toHaveBeenCalled();
    expect(poolMock.acquire.mock.calls[0][1].timeoutMs).toBe(80);

    // Depending on scheduling, the first response may already be terminal if
    // acquire failed inside the expire window; otherwise poll until terminal.
    let current = result;
    for (let attempt = 0; attempt < 20 && current.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      current = await invokeTool(
        "exec-status",
        { job_id: result.job_id, note: "poll hung acquire" },
        "test-session",
        config,
      );
    }

    expect(["running", "failed"].includes(String(result.status))).toBe(true);
    expect(current.status).toBe("failed");
    expect(String(current.error)).toContain("SSH connection error:");
    expect(String(current.error)).toContain("timed out");
  });
});
