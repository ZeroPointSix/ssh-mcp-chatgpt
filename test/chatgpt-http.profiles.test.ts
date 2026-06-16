import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthPayload, invokeTool, listTools, loadRuntimeConfig } from '../src/chatgpt-http';

const mockState = vi.hoisted(() => ({
  connectCalls: [] as any[],
  execCalls: [] as string[],
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');

  class Client extends EventEmitter {
    connect(config: any) {
      mockState.connectCalls.push(config);
      queueMicrotask(() => this.emit('ready'));
    }

    exec(command: string, callback: (error: Error | undefined, stream: any) => void) {
      mockState.execCalls.push(command);
      const stream = new EventEmitter() as any;
      stream.stderr = new EventEmitter();
      stream.close = () => stream.emit('close', null, 'SIGTERM');
      queueMicrotask(() => {
        callback(undefined, stream);
        stream.emit('data', Buffer.from(`ran:${command}\n`));
        stream.emit('close', 0, null);
      });
    }

    end() {
      this.emit('close');
    }
  }

  return { Client };
});

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function configureProfiles(options: { defaultProfile?: string | null } = {}) {
  const profiles: any = {
    profiles: [
      {
        id: 'dev',
        label: 'Development VPS',
        host: '10.0.0.2',
        port: 2222,
        user: 'deploy',
        password: 'dev-secret',
        sudo_enabled: false,
      },
      {
        id: 'prod',
        label: 'Production VPS',
        host: '10.0.0.3',
        username: 'root',
        password: 'prod-secret',
        sudo_enabled: true,
      },
    ],
  };
  if (options.defaultProfile !== null) profiles.default = options.defaultProfile ?? 'dev';

  process.env.SSH_MCP_PROFILES_JSON = JSON.stringify(profiles);
  process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '0';
  process.env.SSH_MCP_DISABLE_SUDO = '0';
  process.env.SSH_MCP_SUDO_PASSWORD = 'sudo-secret';
}

afterEach(async () => {
  mockState.connectCalls.length = 0;
  mockState.execCalls.length = 0;
  restoreEnv();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ChatGPT HTTP SSH profiles', () => {
  it('lists only non-sensitive profile metadata and reports profile health state', async () => {
    configureProfiles();
    const config = loadRuntimeConfig();

    const list = await invokeTool('list-profiles', { note: 'inspect profiles' }, 'session-1', config);
    expect(list).toEqual({
      profiles: [
        { id: 'dev', label: 'Development VPS', sudo_enabled: false, default: true },
        { id: 'prod', label: 'Production VPS', sudo_enabled: true, default: false },
      ],
    });
    expect(JSON.stringify(list)).not.toContain('10.0.0');
    expect(JSON.stringify(list)).not.toContain('secret');

    const health = healthPayload(config);
    expect(health.ssh_profiles_configured).toBe(true);
    expect(health.ssh_profile_count).toBe(2);
    expect(health.default_ssh_profile_id).toBe('dev');
    expect(health.ssh_target_configured).toBe(true);

    const tools = listTools(config);
    expect(tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['list-profiles', 'exec', 'sudo-exec']));
    const execTool = tools.find((tool: any) => tool.name === 'exec') as any;
    expect(execTool.inputSchema.properties.target_id).toBeDefined();
  });

  it('prefers SSH_MCP_PROFILES_FILE over SSH_MCP_PROFILES_JSON when both are configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ssh-mcp-profiles-file-'));
    tempDirs.push(dir);
    const profilesPath = join(dir, 'profiles.json');
    await writeFile(
      profilesPath,
      JSON.stringify({
        default: 'file',
        profiles: [
          {
            id: 'file',
            label: 'File VPS',
            host: '10.0.0.9',
            user: 'deploy',
            password: 'file-secret',
            sudo_enabled: true,
          },
        ],
      }),
      'utf8',
    );

    process.env.SSH_MCP_PROFILES_FILE = profilesPath;
    process.env.SSH_MCP_PROFILES_JSON = JSON.stringify({
      default: 'inline',
      profiles: [
        {
          id: 'inline',
          label: 'Inline VPS',
          host: '10.0.0.8',
          user: 'deploy',
          password: 'inline-secret',
          sudo_enabled: false,
        },
      ],
    });
    process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '0';
    process.env.SSH_MCP_DISABLE_SUDO = '0';

    const config = loadRuntimeConfig();
    const list = await invokeTool('list-profiles', { note: 'inspect file priority' }, 'session-1', config);

    expect(list).toEqual({ profiles: [{ id: 'file', label: 'File VPS', sudo_enabled: true, default: true }] });
    expect(JSON.stringify(list)).not.toContain('inline');
    expect(healthPayload(config).default_ssh_profile_id).toBe('file');
  });

  it('routes exec to an explicit profile target_id', async () => {
    configureProfiles();
    const config = loadRuntimeConfig();

    const result = await invokeTool(
      'exec',
      { target_id: 'prod', command: 'whoami', expire_time_ms: 1000, note: 'test explicit target' },
      'session-1',
      config,
    );

    expect(result.status).toBe('completed');
    expect(result.target_id).toBe('prod');
    expect(result.target_label).toBe('Production VPS');
    expect(mockState.connectCalls.at(-1)).toMatchObject({ host: '10.0.0.3', port: 22, username: 'root', password: 'prod-secret' });
  });

  it('uses the configured default profile when target_id is omitted', async () => {
    configureProfiles();
    const config = loadRuntimeConfig();

    const result = await invokeTool(
      'exec',
      { command: 'hostname', expire_time_ms: 1000, note: 'test default target' },
      'session-1',
      config,
    );

    expect(result.status).toBe('completed');
    expect(result.target_id).toBe('dev');
    expect(mockState.connectCalls.at(-1)).toMatchObject({ host: '10.0.0.2', port: 2222, username: 'deploy', password: 'dev-secret' });
  });

  it('rejects omitted or unknown target_id when no default profile exists', async () => {
    configureProfiles({ defaultProfile: null });
    const config = loadRuntimeConfig();

    await expect(
      invokeTool('exec', { command: 'uptime', note: 'missing target' }, 'session-1', config),
    ).rejects.toThrow('target_id is required because no default SSH profile is configured');

    await expect(
      invokeTool('exec', { target_id: 'missing', command: 'uptime', note: 'unknown target' }, 'session-1', config),
    ).rejects.toThrow('Unknown SSH target_id: missing');
  });

  it('respects per-profile sudo settings in addition to the global sudo switch', async () => {
    configureProfiles();
    const config = loadRuntimeConfig();

    await expect(
      invokeTool('sudo-exec', { target_id: 'dev', command: 'id', note: 'sudo disabled target' }, 'session-1', config),
    ).rejects.toThrow('sudo-exec is disabled for SSH target dev');

    const result = await invokeTool(
      'sudo-exec',
      { target_id: 'prod', command: 'id', expire_time_ms: 1000, note: 'sudo enabled target' },
      'session-1',
      config,
    );
    expect(result.status).toBe('completed');
    expect(result.target_id).toBe('prod');
    expect(mockState.execCalls.at(-1)).toContain('sudo');
  });

  it('preserves single-target environment fallback when no profile config is provided', async () => {
    process.env.SSH_MCP_HOST = '127.0.0.1';
    process.env.SSH_MCP_PORT = '2022';
    process.env.SSH_MCP_USER = 'test';
    process.env.SSH_MCP_PASSWORD = 'legacy-secret';
    process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '0';
    const config = loadRuntimeConfig();

    const list = await invokeTool('list-profiles', { note: 'legacy metadata' }, 'session-1', config);
    expect(list).toEqual({ profiles: [{ id: 'default', label: 'Default SSH target', sudo_enabled: true, default: true }] });

    const result = await invokeTool(
      'exec',
      { target_id: 'default', command: 'whoami', expire_time_ms: 1000, note: 'legacy exec' },
      'session-1',
      config,
    );
    expect(result.target_id).toBe('default');
    expect(mockState.connectCalls.at(-1)).toMatchObject({ host: '127.0.0.1', port: 2022, username: 'test', password: 'legacy-secret' });
  });

  it('writes the resolved target_id to audit logs without exposing commands or secrets', async () => {
    configureProfiles();
    const dir = await mkdtemp(join(tmpdir(), 'ssh-mcp-profiles-'));
    tempDirs.push(dir);
    process.env.SSH_MCP_DATA_DIR = dir;
    process.env.SSH_MCP_TOOL_CALL_LOG_ENABLED = '1';
    const config = loadRuntimeConfig();

    await invokeTool('exec', { command: 'echo secret', expire_time_ms: 1000, note: 'audit default target' }, 'session-a', config);

    const logDate = new Date().toISOString().slice(0, 10);
    const log = await readFile(join(dir, 'tool-calls', `${logDate}.jsonl`), 'utf8');
    const record = JSON.parse(log.trim().split('\n').at(-1) ?? '{}');
    expect(record.arguments.target_id).toBe('dev');
    expect(record.arguments.target_label).toBe('Development VPS');
    expect(record.arguments.command).toBe('[redacted command, 11 chars]');
    expect(JSON.stringify(record)).not.toContain('dev-secret');
    expect(JSON.stringify(record)).not.toContain('echo secret');
  });
});
