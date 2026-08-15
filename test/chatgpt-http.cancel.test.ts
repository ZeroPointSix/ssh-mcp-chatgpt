import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMcp, invokeTool, loadRuntimeConfig } from '../src/chatgpt-http';

const mockState = vi.hoisted(() => ({
  commands: [] as string[],
  commandStream: undefined as any,
  commandClient: undefined as any,
  commandCallbackDelayMs: 0,
  commandCallbackNever: false,
  stopDelayMs: 0,
  stopCloseOnEnd: false,
  stopExitOnly: false,
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');

  class Client extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'));
    }

    exec(command: string, callback: (error: Error | undefined, stream: any) => void) {
      mockState.commands.push(command);
      const stream = new EventEmitter() as any;
      stream.stderr = new EventEmitter();
      stream.end = () => {
        if (command.includes('kill -KILL --') && mockState.stopCloseOnEnd) {
          stream.emit('close', 0, null);
        }
      };
      stream.signal = (_signal: string, signalCallback?: (error?: Error) => void) => {
        signalCallback?.(new Error('SSH signal requests are unsupported'));
      };
      stream.close = () => undefined;

      const dispatchCallback = () => {
        callback(undefined, stream);
        if (command.includes('kill -KILL --')) {
          if (!mockState.stopCloseOnEnd) {
            const event = mockState.stopExitOnly ? 'exit' : 'close';
            setTimeout(() => stream.emit(event, 0, null), mockState.stopDelayMs);
          }
        } else {
          mockState.commandStream = stream;
          mockState.commandClient = this;
        }
      };
      if (!command.includes('kill -KILL --') && mockState.commandCallbackNever) return;
      if (!command.includes('kill -KILL --') && mockState.commandCallbackDelayMs > 0) {
        setTimeout(dispatchCallback, mockState.commandCallbackDelayMs);
      } else {
        queueMicrotask(dispatchCallback);
      }
    }

    end() {
      queueMicrotask(() => this.emit('close'));
    }
  }

  return { Client };
});

const originalEnv = { ...process.env };

function configureSshTarget() {
  process.env.SSH_MCP_HOST = '127.0.0.1';
  process.env.SSH_MCP_PORT = '2222';
  process.env.SSH_MCP_USER = 'test';
  process.env.SSH_MCP_PASSWORD = 'secret';
  process.env.SSH_MCP_DISABLE_SUDO = '1';
  process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '0';
}

afterEach(() => {
  mockState.commands.length = 0;
  mockState.commandStream = undefined;
  mockState.commandClient = undefined;
  mockState.commandCallbackDelayMs = 0;
  mockState.commandCallbackNever = false;
  mockState.stopDelayMs = 0;
  mockState.stopCloseOnEnd = false;
  mockState.stopExitOnly = false;
  vi.useRealTimers();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('exec-cancel remote process-group control', () => {
  it('reaches an idempotent terminal state when the original SSH channel never closes', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();
    const started = await invokeTool(
      'exec',
      { command: 'sleep 60', expire_time_ms: 10, kill_time_ms: 60000, note: 'start held command' },
      'test-session',
      config,
    );

    expect(started.status).toBe('running');
    const requested = await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'cancel held command' },
      'test-session',
      config,
    );
    expect(requested.status).toBe('cancelling');

    await new Promise((resolve) => setTimeout(resolve, 10));
    const terminal = await invokeTool(
      'exec-status',
      { job_id: started.job_id, note: 'confirm held command cancellation' },
      'test-session',
      config,
    );
    expect(terminal.status).toBe('cancelled');
    expect(terminal.completed_at).toBeDefined();
    expect(terminal.stop_signal_sent).toBe(true);

    const repeated = await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'repeat held command cancellation' },
      'test-session',
      config,
    );
    expect(repeated.status).toBe('cancelled');
    expect(repeated.completed_at).toBe(terminal.completed_at);
    expect(repeated.stop_requested_at).toBe(terminal.stop_requested_at);

    expect(mockState.commands).toHaveLength(2);
    expect(mockState.commands[0]).toContain('set -m');
    expect(mockState.commands[0]).toContain('managed_pid=$!');
    expect(mockState.commands[0]).toContain(started.job_id + '.pid');
    expect(mockState.commands[1]).toContain(started.job_id + '.pid');
    expect(mockState.commands[1]).toContain('kill -TERM');
    expect(mockState.commands[1]).toContain('kill -KILL');
  });

  it('waits for the exec callback before starting the cancellation helper', async () => {
    configureSshTarget();
    mockState.commandCallbackDelayMs = 80;
    const config = loadRuntimeConfig();
    const started = await invokeTool(
      'exec',
      { command: 'sleep 60', expire_time_ms: 10, kill_time_ms: 60000, note: 'start delayed-open command' },
      'test-session',
      config,
    );

    const requested = await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'cancel before channel opens' },
      'test-session',
      config,
    );
    expect(requested.status).toBe('cancelling');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockState.commands).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const terminal = await invokeTool(
      'exec-status',
      { job_id: started.job_id, note: 'confirm delayed-open cancellation' },
      'test-session',
      config,
    );
    expect(terminal.status).toBe('cancelled');
    expect(terminal.stop_error).toBeUndefined();
    expect(mockState.commands).toHaveLength(2);
  });

  it('confirms cancellation from helper exit-status before channel close', async () => {
    configureSshTarget();
    mockState.stopExitOnly = true;
    const config = loadRuntimeConfig();
    const started = await invokeTool(
      'exec',
      { command: 'sleep 60', expire_time_ms: 10, kill_time_ms: 60000, note: 'start exit-only helper command' },
      'test-session',
      config,
    );

    await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'cancel with exit-only helper' },
      'test-session',
      config,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const terminal = await invokeTool(
      'exec-status',
      { job_id: started.job_id, note: 'confirm exit-only helper cancellation' },
      'test-session',
      config,
    );
    expect(terminal.status).toBe('cancelled');
    expect(terminal.completed_at).toBeDefined();
  });

  it('fails within the confirmation deadline when the exec callback never arrives', async () => {
    configureSshTarget();
    mockState.commandCallbackNever = true;
    vi.useFakeTimers();
    const config = loadRuntimeConfig();

    const startedPromise = invokeTool(
      'exec',
      { command: 'sleep 60', expire_time_ms: 10, kill_time_ms: 60000, note: 'start missing-ack command' },
      'test-session',
      config,
    );
    await vi.advanceTimersByTimeAsync(11);
    const started = await startedPromise;
    const requested = await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'cancel missing-ack command' },
      'test-session',
      config,
    );
    expect(requested.status).toBe('cancelling');

    await vi.advanceTimersByTimeAsync(5_001);
    const terminal = await invokeTool(
      'exec-status',
      { job_id: started.job_id, note: 'confirm missing-ack failure' },
      'test-session',
      config,
    );
    expect(terminal.status).toBe('failed');
    expect(terminal.stop_error).toContain('did not acknowledge cancellation');
  });

  it('observes a helper that closes synchronously when stdin ends', async () => {
    configureSshTarget();
    mockState.stopCloseOnEnd = true;
    const config = loadRuntimeConfig();
    const started = await invokeTool(
      'exec',
      { command: 'sleep 60', expire_time_ms: 10, kill_time_ms: 60000, note: 'start fast-helper command' },
      'test-session',
      config,
    );

    await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'cancel with fast helper' },
      'test-session',
      config,
    );
    await new Promise((resolve) => setImmediate(resolve));

    const terminal = await invokeTool(
      'exec-status',
      { job_id: started.job_id, note: 'confirm fast helper cancellation' },
      'test-session',
      config,
    );
    expect(terminal.status).toBe('cancelled');
    expect(terminal.completed_at).toBeDefined();
  });

  it.each(['channel', 'connection'] as const)(
    'waits for helper confirmation when the original %s closes first',
    async (closedTransport) => {
      configureSshTarget();
      mockState.stopDelayMs = 60;
      const config = loadRuntimeConfig();
      const started = await invokeTool(
        'exec',
        { command: 'sleep 60', expire_time_ms: 10, kill_time_ms: 60000, note: 'start close-race command' },
        'test-session',
        config,
      );

      await invokeTool(
        'exec-cancel',
        { job_id: started.job_id, note: 'cancel close-race command' },
        'test-session',
        config,
      );
      if (closedTransport === 'channel') {
        mockState.commandStream.emit('close', null, 'SIGTERM');
      } else {
        mockState.commandClient.emit('close');
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      const pending = await invokeTool(
        'exec-status',
        { job_id: started.job_id, note: 'check pending stop confirmation' },
        'test-session',
        config,
      );
      expect(pending.status).toBe('cancelling');
      expect(pending.completed_at).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 70));
      const terminal = await invokeTool(
        'exec-status',
        { job_id: started.job_id, note: 'confirm close-race cancellation' },
        'test-session',
        config,
      );
      expect(terminal.status).toBe('cancelled');
      expect(terminal.completed_at).toBeDefined();
    },
  );

  it('returns status-only and incremental exec-status payloads', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();
    const started = await invokeTool(
      'exec',
      { command: 'sleep 60', expire_time_ms: 10, kill_time_ms: 60000, note: 'start incremental status command' },
      'test-session',
      config,
    );
    expect(started.status).toBe('running');

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockState.commandStream.emit('data', Buffer.from('part-one'));

    const statusOnly = await invokeTool(
      'exec-status',
      { job_id: started.job_id, include_output: false, note: 'status-only poll' },
      'test-session',
      config,
    );
    expect(statusOnly.status).toBe('running');
    expect(statusOnly.stdout).toBe('');
    expect(statusOnly.include_output).toBe(false);
    expect(statusOnly.next_stdout_offset).toBe(8);

    const first = await invokeTool(
      'exec-status',
      {
        job_id: started.job_id,
        include_output: true,
        since_stdout_offset: 0,
        note: 'first incremental poll',
      },
      'test-session',
      config,
    );
    expect(first.stdout).toBe('part-one');
    expect(first.since_stdout_offset).toBe(0);
    expect(first.next_stdout_offset).toBe(8);

    mockState.commandStream.emit('data', Buffer.from('part-two'));
    const second = await invokeTool(
      'exec-status',
      {
        job_id: started.job_id,
        include_output: true,
        since_stdout_offset: first.next_stdout_offset,
        note: 'second incremental poll',
      },
      'test-session',
      config,
    );
    expect(second.stdout).toBe('part-two');
    expect(second.since_stdout_offset).toBe(8);
    expect(second.next_stdout_offset).toBe(16);

    mockState.commandStream.emit('close', 0, null);
    const terminal = await invokeTool(
      'exec-status',
      {
        job_id: started.job_id,
        include_output: false,
        note: 'final status-only poll',
      },
      'test-session',
      config,
    );
    expect(terminal.status).toBe('completed');
    expect(terminal.exit_code).toBe(0);
    expect(terminal.stdout).toBe('');
  });

  it('cancels the remote process group when the HTTP client disconnects mid-wait', async () => {
    configureSshTarget();
    mockState.stopCloseOnEnd = true;
    const config = loadRuntimeConfig();
    const server = createServer((req, res) => {
      void handleMcp(req, res, config);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('HTTP test server did not expose a TCP port');
      }

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'exec',
          arguments: {
            command: 'sleep 60',
            expire_time_ms: 60000,
            kill_time_ms: 60000,
            note: 'client disconnect cancel',
          },
        },
      });
      const request = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      });
      request.on('error', () => {
        // Destroying the client socket is the behavior under test.
      });
      request.end(body);

      for (let attempt = 0; attempt < 100 && !mockState.commandStream; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(mockState.commandStream).toBeDefined();

      request.destroy();

      for (let attempt = 0; attempt < 100 && mockState.commands.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(
        mockState.commands.some(
          (command) => command.includes('kill -TERM') && command.includes('kill -KILL'),
        ),
      ).toBe(true);

      const jobId = mockState.commands[0]?.match(/job-[A-Za-z0-9_-]+/)?.[0];
      expect(jobId).toBeDefined();
      const terminal = await invokeTool(
        'exec-status',
        { job_id: jobId, note: 'confirm disconnect cancellation' },
        'test-session',
        config,
      );
      expect(terminal.status).toBe('cancelled');
      expect(terminal.stop_signal_sent).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
