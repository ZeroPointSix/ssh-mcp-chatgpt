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
    expect(health.default_output_max_chars).toBe(100000);
    expect(health.default_expire_time_ms).toBe(55000);
    expect(health.default_kill_time_ms).toBe(600000);
    expect(health.version).toBe('1.6.3-chatgpt.0');
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

  it('closes stdin and reports non-zero exits as completed command results', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();

    const result = await invokeTool(
      'exec',
      {
        command: '/bin/false',
        expire_time_ms: 5000,
        note: 'verify non-zero exit status',
      },
      'test-session',
      config,
    );

    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(1);
    expect(result.error).toBeUndefined();
  }, 10000);

  it('closes stdin without hanging commands that read it', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();

    const result = await invokeTool(
      'exec',
      {
        command: 'cat >/dev/null',
        expire_time_ms: 5000,
        note: 'verify stdin closure',
      },
      'test-session',
      config,
    );

    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);
    expect(result.error).toBeUndefined();
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

  it('preserves both the head and tail when bounded output is truncated', async () => {
    configureSshTarget();
    process.env.SSH_MCP_EXEC_OUTPUT_MAX_CHARS = '96';
    const config = loadRuntimeConfig();
    const output = 'HEAD-' + 'x'.repeat(160) + '-TAIL';

    const result = await invokeTool(
      'exec',
      { command: "printf '" + output + "'", expire_time_ms: 5000, note: 'test head and tail truncation' },
      'test-session',
      config,
    );

    expect(result.status).toBe('completed');
    expect(result.stdout).toMatch(/^HEAD-/);
    expect(result.stdout).toContain('chars omitted');
    expect(result.stdout).toMatch(/-TAIL$/);
    expect(result.stdout_total_chars).toBe(output.length);
    expect(result.stdout_truncated).toBe(true);
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
    const repeated = await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'repeat cancellation request' },
      'test-session',
      config,
    );
    expect(repeated.stop_requested_at).toBe(cancelled.stop_requested_at);
    expect(repeated.stop_requested_status).toBe('cancelled');
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

    const afterTerminal = await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'repeat cancellation after completion' },
      'test-session',
      config,
    );
    expect(afterTerminal.status).toBe(current.status);
    expect(afterTerminal.completed_at).toBe(current.completed_at);
  }, 10000);

  it('stops background child processes after cancellation', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();
    const marker = '/tmp/ssh-mcp-cancel-marker-' + Date.now();

    const started = await invokeTool(
      'exec',
      {
        command:
          "sh -c \"rm -f '" +
          marker +
          "'; (while true; do date >> '" +
          marker +
          "'; sleep 0.2; done) & sleep 60\"",
        expire_time_ms: 50,
        kill_time_ms: 60000,
        note: 'start cancellable background writer',
      },
      'test-session',
      config,
    );

    expect(started.status).toBe('running');

    await invokeTool(
      'exec-cancel',
      { job_id: started.job_id, note: 'cancel background writer' },
      'test-session',
      config,
    );

    let current = started;
    for (let attempt = 0; attempt < 30 && (current.status === 'running' || current.status === 'cancelling'); attempt += 1) {
      await sleep(150);
      current = await invokeTool('exec-status', { job_id: started.job_id, note: 'poll cancelled writer' }, 'test-session', config);
    }

    expect(['cancelled', 'killed']).toContain(current.status);

    await sleep(600);
    const firstSize = await invokeTool(
      'exec',
      { command: "wc -c < '" + marker + "' 2>/dev/null || printf 0", note: 'measure marker size once' },
      'test-session',
      config,
    );
    await sleep(600);
    const secondSize = await invokeTool(
      'exec',
      { command: "wc -c < '" + marker + "' 2>/dev/null || printf 0", note: 'measure marker size again' },
      'test-session',
      config,
    );
    expect(String(firstSize.stdout).trim()).toBe(String(secondSize.stdout).trim());

    await invokeTool(
      'exec',
      { command: "rm -f -- '" + marker + "'", note: 'clean cancel marker' },
      'test-session',
      config,
    );
  }, 20000);
});
