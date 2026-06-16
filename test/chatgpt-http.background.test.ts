import { afterEach, describe, expect, it } from 'vitest';
import { healthPayload, invokeTool, listTools, loadRuntimeConfig } from '../src/chatgpt-http';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function configureSshTarget() {
  process.env.SSH_MCP_HOST = process.env.SSH_HOST || '127.0.0.1';
  process.env.SSH_MCP_PORT = process.env.SSH_PORT || '2222';
  process.env.SSH_MCP_USER = process.env.SSH_USER || 'test';
  process.env.SSH_MCP_PASSWORD = process.env.SSH_PASSWORD || 'secret';
  process.env.SSH_MCP_DISABLE_SUDO = '1';
  process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '0';
  process.env.SSH_MCP_EXEC_EXPIRE_TIME_MS = '50';
  process.env.SSH_MCP_EXEC_KILL_TIME_MS = '5000';
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  restoreEnv();
});

describe('ChatGPT HTTP background command tools', () => {
  it('advertises background polling controls and unlimited default command length', () => {
    delete process.env.SSH_MCP_MAX_CHARS;
    delete process.env.SSH_MCP_EXEC_OUTPUT_MAX_CHARS;
    process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '0';

    const config = loadRuntimeConfig();
    const health = healthPayload(config);
    const toolNames = listTools(config).map((tool: any) => tool.name);

    expect(health.max_command_chars).toBe('none');
    expect(health.default_output_max_chars).toBe(200000);
    expect(health.default_expire_time_ms).toBe(55000);
    expect(health.default_kill_time_ms).toBe('none');
    expect(toolNames).toEqual(expect.arrayContaining(['exec', 'exec-status', 'exec-cancel']));
  });

  it('returns a running job_id after expire_time_ms and later exposes completion', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();

    const started = await invokeTool(
      'exec',
      { command: 'sh -c "sleep 1; echo background-done"', expire_time_ms: 50, kill_time_ms: 5000, note: 'test background job' },
      'test-session',
      config,
    );

    expect(started.status).toBe('running');
    expect(started.job_id).toMatch(/^job-/);
    expect(started.next_action).toContain('exec-status');

    let current = started;
    for (let attempt = 0; attempt < 20 && current.status === 'running'; attempt += 1) {
      await sleep(150);
      current = await invokeTool('exec-status', { job_id: started.job_id, note: 'poll background job' }, 'test-session', config);
    }

    expect(current.status).toBe('completed');
    expect(current.stdout).toContain('background-done');
    expect(current.stderr).toBe('');
    expect(current.exit_code).toBe(0);
  }, 10000);

  it('retains only bounded output tails with truncation metadata', async () => {
    configureSshTarget();
    process.env.SSH_MCP_EXEC_OUTPUT_MAX_CHARS = '12';
    const config = loadRuntimeConfig();

    const result = await invokeTool(
      'exec',
      { command: 'printf abcdefghijklmnopqr', expire_time_ms: 5000, note: 'test output truncation' },
      'test-session',
      config,
    );

    expect(result.status).toBe('completed');
    expect(result.stdout).toBe('ghijklmnopqr');
    expect(result.stdout_truncated).toBe(true);
    expect(result.stdout_total_chars).toBe(18);
    expect(result.stderr_truncated).toBe(false);
    expect(result.output_max_chars).toBe(12);
  }, 10000);

  it('reports cancellation as requested before the final terminal status is confirmed', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();

    const started = await invokeTool(
      'exec',
      { command: 'sh -c "sleep 5; echo should-not-finish"', expire_time_ms: 50, kill_time_ms: 5000, note: 'test cancellation job' },
      'test-session',
      config,
    );

    expect(started.status).toBe('running');

    const cancelled = await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'cancel background job' },
      'test-session',
      config,
    );

    expect(['cancelling', 'cancelled']).toContain(cancelled.status);
    expect(cancelled.stop_requested_status).toBe('cancelled');
    if (cancelled.status === 'cancelling') {
      expect(cancelled.completed_at).toBeUndefined();
      expect(cancelled.next_action).toContain('exec-status');
    }

    let current = cancelled;
    for (let attempt = 0; attempt < 20 && (current.status === 'running' || current.status === 'cancelling'); attempt += 1) {
      await sleep(150);
      current = await invokeTool('exec-status', { job_id: started.job_id, note: 'poll cancelled job' }, 'test-session', config);
    }

    expect(['cancelled', 'killed']).toContain(current.status);
    expect(current.completed_at).toBeDefined();
  }, 10000);
});
