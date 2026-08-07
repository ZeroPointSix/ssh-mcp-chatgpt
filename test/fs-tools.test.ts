import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FS_MAX_BYTES,
  DEFAULT_FS_READ_MAX_LINES,
  FS_CONTENT_SENTINEL,
  FsToolError,
  assertPathAllowed,
  buildPreview,
  buildRawReadScript,
  buildReadScript,
  buildResolvePathScript,
  buildRunCommand,
  buildWriteScript,
  decodeContent,
  decodeFileContent,
  fsToolDefinitions,
  isFsToolName,
  loadFsRuntimeConfig,
  normalizeRemotePath,
  parseAllowedRoots,
  parseFileMode,
  parseFsResultLine,
  parseOwner,
  parseSha256,
  parseWriteOutcome,
  redactFsArgs,
  sha256Hex,
  shellQuote,
  syntaxCheckStatement,
} from '../src/fs-tools';

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe('remote path guards', () => {
  it('accepts absolute paths and collapses redundant segments', () => {
    expect(normalizeRemotePath('/root/work/app.sh')).toBe('/root/work/app.sh');
    expect(normalizeRemotePath('  /root//work/./app.sh  ')).toBe('/root/work/app.sh');
    expect(normalizeRemotePath('/root/work/')).toBe('/root/work');
  });

  it('rejects relative paths, parent segments, and control characters', () => {
    expect(() => normalizeRemotePath('work/app.sh')).toThrow(/absolute/);
    expect(() => normalizeRemotePath('/root/../etc/passwd')).toThrow(/\.\. segments/);
    expect(() => normalizeRemotePath('/root/app\nrm -rf /')).toThrow(/newline/);
    expect(() => normalizeRemotePath('/')).toThrow(/root directory/);
    expect(() => normalizeRemotePath('')).toThrow(/non-empty/);
  });

  it('keeps writes inside the allowed roots', () => {
    const roots = parseAllowedRoots('/root/work, /opt/app/');
    expect(roots).toEqual(['/root/work', '/opt/app']);

    expect(() => assertPathAllowed('/root/work/app.sh', roots)).not.toThrow();
    expect(() => assertPathAllowed('/opt/app', roots)).not.toThrow();
    expect(() => assertPathAllowed('/etc/passwd', roots)).toThrow(FsToolError);
    expect(() => assertPathAllowed('/root/workspace/app.sh', roots)).toThrow(/allowed roots/);
  });

  it('rejects every path when no root is configured', () => {
    expect(parseAllowedRoots(undefined)).toEqual([]);
    expect(() => assertPathAllowed('/etc/hosts', [])).toThrow(/No allowed roots/);
  });

  it('resolves real paths before applying the remote allowlist', () => {
    const script = buildResolvePathScript('/srv/app/config', ['/srv/app'], false);
    expect(script.indexOf('canonical=$(realpath')).toBeLessThan(script.indexOf('case "$canonical"'));
    expect(script).toContain('root_real=$(realpath -m "$root")');
    expect(script).toContain('exit 77');
  });
});

describe('payload handling', () => {
  it('quotes values for the shell', () => {
    expect(shellQuote('/root/work/app.sh')).toBe("'/root/work/app.sh'");
    expect(shellQuote("/root/it's/app.sh")).toBe("'/root/it'\\''s/app.sh'");
  });

  it('decodes utf8 and base64 content', () => {
    expect(decodeContent('hello', 'utf8').toString('utf8')).toBe('hello');
    expect(decodeContent('aGVsbG8=', 'base64').toString('utf8')).toBe('hello');
    expect(() => decodeContent('not base64!', 'base64')).toThrow(/valid base64/);
    expect(() => decodeContent(42, 'utf8')).toThrow(/must be a string/);
    expect(decodeFileContent({ content: 'a\r\nb' }).payload.toString()).toBe('a\nb');
    expect(decodeFileContent({ content_base64: 'aGVsbG8=' }).payload.toString()).toBe('hello');
    expect(() => decodeFileContent({ content: 'a', content_base64: 'YQ==' })).toThrow(/exactly one/);
  });

  it('builds a bounded preview', () => {
    expect(buildPreview('short', 400)).toEqual({ preview: 'short', preview_truncated: false });

    const preview = buildPreview('x'.repeat(50), 10);
    expect(preview.preview_truncated).toBe(true);
    expect(preview.preview).toContain('\n...\n');
    expect(preview.preview.length).toBeLessThan(50);
  });

  it('validates the option values', () => {
    expect(parseFileMode('0755')).toBe('0755');
    expect(parseFileMode(undefined)).toBeUndefined();
    expect(() => parseFileMode('999')).toThrow(/octal/);

    expect(parseSha256(undefined, 'expected_sha256')).toBeUndefined();
    expect(parseSha256('A'.repeat(64), 'expected_sha256')).toBe('a'.repeat(64));
    expect(() => parseSha256('abc', 'expected_sha256')).toThrow(/64 character hex/);

    expect(parseOwner('root:root')).toEqual({ user: 'root', group: 'root' });
    expect(() => parseOwner('root')).toThrow(/user:group/);
  });

  it('computes stable sha256 values', () => {
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sha256Hex(Buffer.from('hello', 'utf8'))).toBe(sha256Hex('hello'));
  });
});

describe('remote script builders', () => {
  const writeOptions = {
    path: '/root/work/app.sh',
    stagingPath: '/tmp/.mcp/staging/id',
    createDirs: false,
    fileMode: '0755',
    payloadSha: 'a'.repeat(64),
    verify: true,
    elevate: false,
  };

  it('installs an SFTP staging file through a same-directory temporary file', () => {
    const script = buildWriteScript(writeOptions);
    expect(script).toContain("staging='/tmp/.mcp/staging/id'");
    expect(script).toContain('install -m 0755 "$staging" "$install_tmp"');
    expect(script).toContain('mv -f "$install_tmp" "$target"');
    expect(script).not.toContain('base64 -d');
  });

  it('checks expected_sha256 before backup or replacement', () => {
    const script = buildWriteScript({
      ...writeOptions,
      expectedSha: 'b'.repeat(64),
      backupSuffix: '.bak.1700000000000',
    });
    const conflict = script.indexOf('FS_CONFLICT');
    expect(conflict).toBeLessThan(script.indexOf('cp -a "$target"'));
    expect(conflict).toBeLessThan(script.indexOf('install -m'));
  });

  it('uses sudo install with explicit owner for elevated writes', () => {
    const script = buildWriteScript({
      ...writeOptions,
      owner: { user: 'root', group: 'root' },
      elevate: true,
    });
    expect(script).toMatch(/^sudo -n sh -c /);
    expect(script).toContain('install -m 0755 -o');
  });

  it('bounds reads on the remote side before stdout reaches Node', () => {
    const script = buildReadScript('/root/work/app.sh', 5, 10, 50);
    expect(script).toContain(FS_CONTENT_SENTINEL);
    expect(script).toContain('awk -v start=5 -v count=10');
    expect(script).toContain('head -c 51');
    expect(script).not.toContain('cat "$target"');

    const raw = buildRawReadScript('/root/work/app.sh', 100);
    expect(raw).toContain('if [ "$size" -gt 100 ]');
    expect(raw).toContain('head -c 101');
  });

  it('builds a quoted run command with args, cwd, env, and elevation', () => {
    const command = buildRunCommand('/root/work/app.sh', 'bash', {
      args: ['--name', 'two words'],
      cwd: '/root/work',
      env: { MODE: 'check' },
      elevate: true,
    });
    expect(command).toContain('sudo -n sh -c');
    expect(command).toContain('/root/work');
    expect(command).toContain('MODE=');
    expect(command).toContain('two words');
  });

  it('parses the remote result line', () => {
    const digest = 'a'.repeat(64);
    expect(parseFsResultLine(`FS_RESULT 128 ${digest}\n`)).toEqual({ bytes: 128, sha256: digest, lineCount: undefined });
    expect(parseFsResultLine(`noise\nFS_RESULT 12 ${digest} 4\n${FS_CONTENT_SENTINEL}\nbody`)).toEqual({
      bytes: 12,
      sha256: digest,
      lineCount: 4,
    });
    expect(() => parseFsResultLine('no result here')).toThrow(/did not report a result/);
    expect(parseWriteOutcome(`FS_UNCHANGED 12 ${digest}\n`).unchanged).toBe(true);
  });
});

describe('runtime configuration and tool descriptors', () => {
  it('uses safe defaults', () => {
    const config = loadFsRuntimeConfig(env({}));
    expect(config.enabled).toBe(false);
    expect(config.allowedRoots).toEqual([]);
    expect(config.maxBytes).toBe(DEFAULT_FS_MAX_BYTES);
    expect(config.readMaxLines).toBe(DEFAULT_FS_READ_MAX_LINES);
    expect(config.syntaxCheckEnabled).toBe(true);
  });

  it('reads the environment overrides', () => {
    const config = loadFsRuntimeConfig(
      env({
        SSH_MCP_FS_ALLOWED_ROOTS: '/root/work,/opt/app',
        SSH_MCP_FS_MAX_BYTES: 'none',
        SSH_MCP_FS_SYNTAX_CHECK: '0',
        SSH_MCP_FS_READ_MAX_CHARS: '5000',
      }),
    );
    expect(config.allowedRoots).toEqual(['/root/work', '/opt/app']);
    expect(config.maxBytes).toBe(Infinity);
    expect(config.syntaxCheckEnabled).toBe(false);
    expect(config.readMaxChars).toBe(5000);
  });

  it('rejects an invalid limit', () => {
    expect(() => loadFsRuntimeConfig(env({ SSH_MCP_FS_MAX_BYTES: 'big' }))).toThrow(/positive integer/);
  });

  it('publishes the four file tools, and none when disabled', () => {
    const config = loadFsRuntimeConfig(env({ SSH_MCP_FS_TOOLS_ENABLED: '1', SSH_MCP_FS_ALLOWED_ROOTS: '/root/work' }));
    const names = fsToolDefinitions(config).map((tool) => tool.name);
    expect(names).toEqual(['fs-write', 'fs-read', 'fs-edit', 'run-script']);
    expect(names.every((name) => isFsToolName(String(name)))).toBe(true);
    expect(isFsToolName('exec')).toBe(false);

    expect(fsToolDefinitions(loadFsRuntimeConfig(env({ SSH_MCP_FS_TOOLS_ENABLED: 'false' })))).toEqual([]);
  });

  it('keeps file bodies out of the audit log', () => {
    const redacted = redactFsArgs({ path: '/root/work/app.sh', content: 'secret body', old_string: 'a', new_string: 'b' });
    expect(redacted.path).toBe('/root/work/app.sh');
    expect(String(redacted.content)).toContain('11 chars');
    expect(String(redacted.content)).not.toContain('secret body');
    expect(String(redacted.old_string)).toContain('1 chars');
    expect(String(redacted.new_string)).toContain('1 chars');
  });
});
