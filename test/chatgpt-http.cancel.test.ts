import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTool, loadRuntimeConfig } from '../src/chatgpt-http';

const mockState = vi.hoisted(() => ({
  commands: [] as string[],
  commandStream: undefined as any,
  commandClient: undefined as any,
  stopDelayMs: 0,
  stopCloseOnEnd: false,
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

      queueMicrotask(() => {
        callback(undefined, stream);
        if (command.includes('kill -KILL --')) {
          if (!mockState.stopCloseOnEnd) {
            setTimeout(() => stream.emit('close', 0, null), mockState.stopDelayMs);
          }
        } else {
          mockState.commandStream = stream;
          mockState.commandClient = this;
        }
      });
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
  mockState.stopDelayMs = 0;
  mockState.stopCloseOnEnd = false;
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
});
