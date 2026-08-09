import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const poolMock = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("../src/ssh-connection-pool.js", () => ({
  withSshConnection: vi.fn(
    async (_config: unknown, callback: (client: unknown) => Promise<unknown>) =>
      callback(poolMock.client),
  ),
}));

import { writeRemoteFile } from "../src/remote-tools.js";

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();

  constructor(
    private readonly stdout: string,
    private readonly exitCode = 0,
  ) {
    super();
  }

  end(): void {
    queueMicrotask(() => {
      if (this.stdout) this.emit("data", Buffer.from(this.stdout));
      this.emit("close", this.exitCode, null);
    });
  }

  close(): void {}
}

describe("remote tool SFTP lifecycle", () => {
  it("closes the SFTP channel and cleans staging after an upload failure", async () => {
    const commands: string[] = [];
    const lifecycle: string[] = [];
    const sftp = Object.assign(new EventEmitter(), {
      writeFile: vi.fn(
        (
          _path: string,
          _content: Buffer,
          _options: { mode: number },
          callback: (error?: Error) => void,
        ) => callback(new Error("simulated write failure")),
      ),
      end: vi.fn(() => {
        lifecycle.push("sftp-end");
        queueMicrotask(() => {
          lifecycle.push("sftp-close");
          sftp.emit("close");
        });
      }),
    });
    poolMock.client = {
      exec: (command: string, callback: (error: undefined, stream: FakeChannel) => void) => {
        commands.push(command);
        lifecycle.push("exec:" + command);
        const stdout = command.startsWith("realpath -m")
          ? "/tmp/failure.txt\n"
          : command.includes("sha256sum")
            ? "__MISSING__"
            : "";
        callback(undefined, new FakeChannel(stdout));
      },
      sftp: (callback: (error: undefined, wrapper: typeof sftp) => void) => {
        callback(undefined, sftp);
      },
    };

    await expect(
      writeRemoteFile(
        {
          sshConfig: {
            host: "example.test",
            port: 22,
            username: "tester",
          },
          allowedRoots: ["/tmp"],
        },
        {
          path: "/tmp/failure.txt",
          content: "content",
          backup: false,
        },
      ),
    ).rejects.toMatchObject({ stage: "write" });

    expect(sftp.writeFile).toHaveBeenCalledOnce();
    expect(sftp.end).toHaveBeenCalledOnce();
    expect(commands.some((command) => command.includes("rm -f --"))).toBe(true);
    expect(commands.some((command) => command.includes("install -m"))).toBe(false);
    expect(lifecycle.indexOf("sftp-close")).toBeLessThan(
      lifecycle.findIndex((entry) => entry.startsWith("exec:rm -f --")),
    );
  });
});

