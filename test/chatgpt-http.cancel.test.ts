import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTool, loadRuntimeConfig } from '../src/chatgpt-http';

const mockState = vi.hoisted(() => ({
  commands: [] as string[],
}));

vi.mock('ssh2', () => {
  class Client extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'));
    }

    exec(command: string, callback: (error: Error | undefined, stream: any) => void) {
      mockState.commands.push(command);
      const stream = new EventEmitter() as any;
      stream.stderr = new EventEmitter();
      stream.end = () => undefined;
      stream.signal = (_signal: string, signalCallback?: (error?: Error) => void) => {
        signalCallback?.(new Error('SSH signal requests are unsupported'));
      };
      stream.close = () => undefined;

      queueMicrotask(() => {
        callback(undefined, stream);
        if (command.includes('kill -KILL --')) stream.emit('close', 0, null);
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
    expect(mockState.commands[0]).toContain('setsid bash -c');
    expect(mockState.commands[0]).toContain(started.job_id + '.pid');
    expect(mockState.commands[1]).toContain(started.job_id + '.pid');
    expect(mockState.commands[1]).toContain('kill -TERM');
    expect(mockState.commands[1]).toContain('kill -KILL');
  });
});
