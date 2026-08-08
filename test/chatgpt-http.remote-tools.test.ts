import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { invokeTool, listTools, loadRuntimeConfig } from '../src/chatgpt-http';
import {
  buildManagedRemoteCancelCommand,
  buildSyntaxCheckCommand,
  remoteWorkspaceRoot,
  wrapManagedRemoteCommand,
} from '../src/remote-tools';

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
  process.env.SSH_MCP_EXEC_EXPIRE_TIME_MS = '5000';
  process.env.SSH_MCP_EXEC_KILL_TIME_MS = '10000';
  process.env.SSH_MCP_FS_ALLOWED_ROOTS = '/tmp';
}

function configureSshTargetWithSudo() {
  configureSshTarget();
  delete process.env.SSH_MCP_DISABLE_SUDO;
  process.env.SSH_MCP_SUDO_PASSWORD = process.env.SSH_PASSWORD || 'secret';
}

afterEach(() => {
  restoreEnv();
});

describe('Claude Code-style remote tools', () => {
  it('advertises dedicated tools and a bounded single-line exec schema', () => {
    process.env.SSH_MCP_MAX_CHARS = '128';
    process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '0';
    const tools = listTools(loadRuntimeConfig()) as any[];
    const names = tools.map((tool) => tool.name);
    const execTool = tools.find((tool) => tool.name === 'exec');
    const runScript = tools.find((tool) => tool.name === 'run-script');

    expect(names).toEqual(expect.arrayContaining(['fs-read', 'fs-write', 'fs-edit', 'run-script']));
    expect(execTool.inputSchema.properties.command.maxLength).toBe(128);
    expect(execTool.description).toContain('single-line');
    expect(execTool.description).toContain('run-script');
    expect(execTool.description).toContain('600000');
    const execStatus = tools.find((tool) => tool.name === 'exec-status');
    expect(execStatus?.description).toContain('run-script');
    const fsWrite = tools.find((tool) => tool.name === 'fs-write');
    expect(fsWrite?.inputSchema.properties.verify.description).toContain('Default false');
    expect(runScript.inputSchema.oneOf).toEqual([
      { required: ['content'] },
      { required: ['path'] },
    ]);
  });

  it('scopes staging paths per ssh user and wraps managed commands', () => {
    expect(remoteWorkspaceRoot({ sshConfig: { username: 'deploy' } } as any, 'staging')).toBe(
      '/tmp/.mcp/users/deploy/staging',
    );
    expect(wrapManagedRemoteCommand('echo hi')).toContain('bash -c');
    expect(wrapManagedRemoteCommand('echo hi')).toContain('set -m');
    expect(wrapManagedRemoteCommand('echo hi')).toContain('managed_pid=$!');
    expect(wrapManagedRemoteCommand('echo hi')).toContain('exit $?');
    expect(wrapManagedRemoteCommand('echo hi', { usesStdin: true })).toContain('bash -c');
    expect(wrapManagedRemoteCommand('echo hi')).toContain('kill -TERM -- "-$managed_pid"');
    expect(wrapManagedRemoteCommand('echo hi')).toContain('HUP');

    const managed = wrapManagedRemoteCommand('sleep 60', { jobId: 'job-test_1' });
    expect(managed).toContain('/tmp/.mcp/jobs/job-test_1.pid');
    const cancel = buildManagedRemoteCancelCommand('job-test_1');
    expect(cancel).toContain('/tmp/.mcp/jobs/job-test_1.pid');
    expect(cancel).toContain('kill -TERM');
    expect(cancel).toContain('kill -KILL');
    expect(() => buildManagedRemoteCancelCommand('bad/job')).toThrow('Invalid managed job ID');

    const trailingSemicolon = wrapManagedRemoteCommand('printf ok;');
    expect(trailingSemicolon).not.toContain(';; exit $?');
    expect(execFileSync('bash', ['-c', trailingSemicolon], { encoding: 'utf8' })).toBe('ok');

    const trailingComment = wrapManagedRemoteCommand('printf ok # trailing comment');
    expect(execFileSync('bash', ['-c', trailingComment], { encoding: 'utf8' })).toBe('ok');
    expect(buildSyntaxCheckCommand('python3', '/tmp/example.py')).toContain('ast.parse');
    expect(buildSyntaxCheckCommand('python3', '/tmp/example.py')).not.toContain('py_compile');
  });

  it.each([
    ['newline', 'printf first\nprintf second'],
    ['heredoc', "cat <<'EOF'\nvalue\nEOF"],
  ])('rejects %s from exec', async (_label, command) => {
    configureSshTarget();
    await expect(
      invokeTool('exec', { command, note: 'verify command policy' }, 'test-session', loadRuntimeConfig()),
    ).rejects.toMatchObject({ code: 'COMMAND_POLICY' });
  });

  it('allows single-line control flow on exec for backward compatibility', async () => {
    configureSshTarget();
    const result = await invokeTool(
      'exec',
      { command: 'for item in 1 2; do printf "$item"; done', note: 'single-line loop' },
      'test-session',
      loadRuntimeConfig(),
    );
    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);
    expect(String(result.stdout).trim()).toBe('12');
  }, 10000);

  it('round-trips write, read, edit, conflict detection, and unchanged writes', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();
    const root = '/tmp/ssh-mcp-tools-' + Date.now();
    const path = root + '/sample.txt';

    const written = await invokeTool(
      'fs-write',
      {
        path,
        content: 'alpha\r\nbeta\n',
        create_dirs: true,
        backup: false,
        verify: true,
        note: 'write test file',
      },
      'test-session',
      config,
    );
    expect(written.bytes_written).toBeGreaterThan(0);
    expect(written.sha256).toMatch(/^[a-f0-9]{64}$/);

    await invokeTool(
      'exec',
      { command: "chmod 0600 -- '" + path + "'", note: 'restrict file permissions' },
      'test-session',
      config,
    );

    const firstRead = await invokeTool(
      'fs-read',
      { path, note: 'read test file' },
      'test-session',
      config,
    );
    expect(firstRead.content).toBe('     1\talpha\n     2\tbeta');
    expect(firstRead.total_lines).toBe(2);
    expect(firstRead.truncated).toBe(false);

    const edited = await invokeTool(
      'fs-edit',
      {
        path,
        old_string: 'beta',
        new_string: 'gamma',
        note: 'edit test file',
      },
      'test-session',
      config,
    );
    expect(edited.replacements).toBe(1);
    expect(edited.sha256).not.toBe(firstRead.sha256);
    expect(edited.backup_path).toMatch(/^\/tmp\/ssh-mcp-tools-.+\.bak\.\d{14}$/);

    const editedMode = await invokeTool(
      'exec',
      { command: "stat -c '%a' -- '" + path + "'", note: 'verify preserved file mode' },
      'test-session',
      config,
    );
    expect(String(editedMode.stdout).trim()).toBe('600');

    const backupRead = await invokeTool(
      'fs-read',
      { path: edited.backup_path, note: 'verify backup content' },
      'test-session',
      config,
    );
    expect(backupRead.content).toBe('     1\talpha\n     2\tbeta');

    await expect(
      invokeTool(
        'fs-write',
        {
          path,
          content: 'conflicting update\n',
          expected_sha256: '0'.repeat(64),
          backup: false,
          note: 'verify conflict',
        },
        'test-session',
        config,
      ),
    ).rejects.toMatchObject({ stage: 'conflict' });

    const current = await invokeTool('fs-read', { path, note: 'read edited file' }, 'test-session', config);
    const unchanged = await invokeTool(
      'fs-write',
      {
        path,
        content: 'alpha\ngamma\n',
        expected_sha256: current.sha256,
        backup: false,
        note: 'verify unchanged write',
      },
      'test-session',
      config,
    );
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged.bytes_written).toBe(0);

    await invokeTool(
      'exec',
      { command: "rm -rf -- '" + root + "'", note: 'clean remote test files' },
      'test-session',
      config,
    );
  }, 30000);

  it('rejects oversized files before reading their content', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();
    const path = '/tmp/ssh-mcp-oversized-' + Date.now() + '.txt';

    await invokeTool(
      'exec',
      { command: "truncate -s 9437184 -- '" + path + "'", note: 'prepare oversized file' },
      'test-session',
      config,
    );
    await expect(
      invokeTool('fs-read', { path, note: 'reject oversized file' }, 'test-session', config),
    ).rejects.toMatchObject({ stage: 'read' });
    await invokeTool(
      'exec',
      { command: "rm -f -- '" + path + "'", note: 'clean oversized file' },
      'test-session',
      config,
    );
  }, 30000);

  it('returns actionable exact-match errors from fs-edit', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();
    const path = '/tmp/ssh-mcp-edit-' + Date.now() + '.txt';
    await invokeTool(
      'fs-write',
      { path, content: 'same\nsame\n', backup: false, note: 'prepare edit fixture' },
      'test-session',
      config,
    );

    await expect(
      invokeTool(
        'fs-edit',
        { path, old_string: 'same', new_string: 'changed', note: 'verify multiple matches' },
        'test-session',
        config,
      ),
    ).rejects.toMatchObject({ stage: 'match', details: { matches: 2, lines: [1, 2] } });

    await expect(
      invokeTool(
        'fs-edit',
        { path, old_string: 'missing text', new_string: 'changed', note: 'verify missing match' },
        'test-session',
        config,
      ),
    ).rejects.toMatchObject({ stage: 'match', details: { matches: 0 } });

    await invokeTool(
      'exec',
      { command: "rm -f -- '" + path + "'", note: 'clean edit fixture' },
      'test-session',
      config,
    );
  }, 30000);

  it('stages scripts, passes stdin and env, and checks syntax before execution', async () => {
    configureSshTarget();
    const config = loadRuntimeConfig();
    const marker = '/tmp/ssh-mcp-syntax-marker-' + Date.now();

    const result = await invokeTool(
      'run-script',
      {
        content: 'set -eu\nread value\nfor item in 1 2; do\n  echo "$PREFIX-$value-$item"\ndone\n',
        interpreter: 'bash',
        env: { PREFIX: 'ok' },
        stdin: 'input\n',
        note: 'verify staged script execution',
      },
      'test-session',
      config,
    );
    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('ok-input-1\nok-input-2\n');

    const stagedFiles = await invokeTool(
      'exec',
      {
        command: "find '" + remoteWorkspaceRoot({ sshConfig: { username: process.env.SSH_MCP_USER || 'test' } } as any, 'scripts') + "' -type f -print -quit",
        note: 'verify staged script cleanup',
      },
      'test-session',
      config,
    );
    expect(String(stagedFiles.stdout).trim()).toBe('');

    await expect(
      invokeTool(
        'run-script',
        {
          content: "printf touched > '" + marker + "'\nif then\n",
          interpreter: 'bash',
          note: 'verify syntax gate',
        },
        'test-session',
        config,
      ),
    ).rejects.toMatchObject({ stage: 'syntax' });

    const sideEffect = await invokeTool(
      'exec',
      { command: "test ! -e '" + marker + "'", note: 'verify no syntax side effect' },
      'test-session',
      config,
    );
    expect(sideEffect.exit_code).toBe(0);
  }, 30000);

  it('runs sudo-exec and elevated run-script against the live sshd service', async () => {
    configureSshTargetWithSudo();
    const config = loadRuntimeConfig();

    const sudoResult = await invokeTool(
      'sudo-exec',
      { command: 'id -u', note: 'verify sudo-exec path' },
      'test-session',
      config,
    );
    expect(sudoResult.status).toBe('completed');
    expect(sudoResult.exit_code).toBe(0);
    expect(String(sudoResult.stdout).trim()).toBe('0');

    const elevatedScript = await invokeTool(
      'run-script',
      {
        content: 'id -u\n',
        interpreter: 'bash',
        elevate: true,
        note: 'verify elevated run-script path',
      },
      'test-session',
      config,
    );
    expect(elevatedScript.status).toBe('completed');
    expect(elevatedScript.exit_code).toBe(0);
    expect(String(elevatedScript.stdout).trim()).toBe('0');
  }, 30000);
});

type CorpusCase =
  | { level: string; name: string; tool: 'exec'; command: string; expected: string }
  | { level: string; name: string; tool: 'run-script'; content: string; expected: string }
  | { level: string; name: string; tool: 'fs-write'; content: string; expected: string };

const corpus: CorpusCase[] = [
  { level: 'L1', name: 'single printf', tool: 'exec', command: 'printf L1-one', expected: 'L1-one' },
  { level: 'L1', name: 'arithmetic expansion', tool: 'exec', command: 'printf "$((2+3))"', expected: '5' },
  { level: 'L1', name: 'working directory', tool: 'exec', command: 'pwd', expected: '/' },
  { level: 'L2', name: 'one pipeline', tool: 'exec', command: "printf 'a\\nb\\n' | wc -l", expected: '2' },
  { level: 'L2', name: 'case conversion', tool: 'exec', command: 'printf abc | tr a-z A-Z', expected: 'ABC' },
  { level: 'L2', name: 'pipeline sorting', tool: 'exec', command: "printf 'z\\ny\\n' | sort | head -n 1", expected: 'y' },
  { level: 'L3', name: 'awk field extraction', tool: 'exec', command: "printf 'a:7\\n' | awk -F: '{print $2}'", expected: '7' },
  { level: 'L3', name: 'JSON byte count', tool: 'exec', command: "printf '[1,2]' | wc -c", expected: '5' },
  { level: 'L4', name: 'loop', tool: 'run-script', content: 'for i in 1 2; do printf "$i"; done\n', expected: '12' },
  { level: 'L4', name: 'conditional', tool: 'run-script', content: 'if true; then printf yes; else printf no; fi\n', expected: 'yes' },
  { level: 'L4', name: 'multi-line while', tool: 'run-script', content: 'value=2\nwhile [ "$value" -gt 0 ]; do\n  printf "$value"\n  value=$((value-1))\ndone\n', expected: '21' },
  { level: 'L5', name: 'file content instead of heredoc command', tool: 'fs-write', content: 'heredoc-equivalent\n', expected: 'heredoc-equivalent' },
];

describe('12-case L1-L5 tool corpus', () => {
  it.each(corpus)('$level $name uses $tool', async (entry) => {
    configureSshTarget();
    const config = loadRuntimeConfig();

    if (entry.tool === 'exec') {
      const result = await invokeTool(
        'exec',
        { command: entry.command, note: 'run tool corpus case' },
        'test-session',
        config,
      );
      expect(result.status).toBe('completed');
      expect(result.exit_code).toBe(0);
      expect(String(result.stdout).trim()).toContain(entry.expected);
      return;
    }

    if (entry.tool === 'run-script') {
      await expect(
        invokeTool(
          'exec',
          { command: entry.content, note: 'verify script routing policy' },
          'test-session',
          config,
        ),
      ).rejects.toMatchObject({ code: 'COMMAND_POLICY' });
      const result = await invokeTool(
        'run-script',
        { content: entry.content, interpreter: 'bash', note: 'run tool corpus script' },
        'test-session',
        config,
      );
      expect(result.status).toBe('completed');
      expect(result.exit_code).toBe(0);
      expect(String(result.stdout).trim()).toContain(entry.expected);
      return;
    }

    const path = '/tmp/ssh-mcp-corpus-' + Date.now() + '.txt';
    await expect(
      invokeTool(
        'exec',
        { command: "cat <<'EOF'\n" + entry.content + 'EOF', note: 'verify heredoc policy' },
        'test-session',
        config,
      ),
    ).rejects.toMatchObject({ code: 'COMMAND_POLICY' });
    await invokeTool(
      'fs-write',
      { path, content: entry.content, backup: false, note: 'write corpus file' },
      'test-session',
      config,
    );
    const result = await invokeTool('fs-read', { path, note: 'read corpus file' }, 'test-session', config);
    expect(result.content).toContain(entry.expected);
    await invokeTool(
      'exec',
      { command: "rm -f -- '" + path + "'", note: 'clean corpus file' },
      'test-session',
      config,
    );
  }, 20000);
});
