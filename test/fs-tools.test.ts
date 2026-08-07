import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FS_MAX_BYTES,
  FS_CONTENT_SENTINEL,
  FsToolError,
  assertPathAllowed,
  buildPreview,
  buildReadScript,
  buildRunCommand,
  buildWriteScript,
  decodeContent,
  fsToolDefinitions,
  isFsToolName,
  loadFsRuntimeConfig,
  normalizeRemotePath,
  parseAllowedRoots,
  parseEncoding,
  parseFileMode,
  parseFsResultLine,
  parseSha256,
  parseWriteMode,
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

  it('allows every absolute path when no root is configured', () => {
    expect(parseAllowedRoots(undefined)).toEqual([]);
    expect(() => assertPathAllowed('/etc/hosts', [])).not.toThrow();
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
  });

  it('builds a bounded preview', () => {
    expect(buildPreview('short', 400)).toEqual({ preview: 'short', preview_truncated: false });

    const preview = buildPreview('x'.repeat(50), 10);
    expect(preview.preview_truncated).toBe(true);
    expect(preview.preview).toContain('\n...\n');
    expect(preview.preview.length).toBeLessThan(50);
  });

  it('validates the option values', () => {
    expect(parseWriteMode(undefined)).toBe('overwrite');
    expect(parseWriteMode('append')).toBe('append');
    expect(() => parseWriteMode('delete')).toThrow(/create, overwrite, or append/);

    expect(parseEncoding(undefined)).toBe('utf8');
    expect(parseEncoding('base64')).toBe('base64');
    expect(() => parseEncoding('hex')).toThrow(/utf8 or base64/);

    expect(parseFileMode('0755')).toBe('0755');
    expect(parseFileMode(undefined)).toBeUndefined();
    expect(() => parseFileMode('999')).toThrow(/octal/);

    expect(parseSha256(undefined, 'expected_sha256')).toBeUndefined();
    expect(parseSha256('A'.repeat(64), 'expected_sha256')).toBe('a'.repeat(64));
    expect(() => parseSha256('abc', 'expected_sha256')).toThrow(/64 character hex/);
  });

  it('computes stable sha256 values', () => {
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sha256Hex(Buffer.from('hello', 'utf8'))).toBe(sha256Hex('hello'));
  });
});

describe('remote script builders', () => {
  it('sends the content through stdin and never through the command line', () => {
    const script = buildWriteScript({ path: '/root/work/app.sh', mode: 'overwrite', createDirs: true, fileMode: '755' });

    expect(script).toContain("target='/root/work/app.sh'");
    expect(script).toContain('base64 -d > "$tmp"');
    expect(script).toContain('mkdir -p "$(dirname "$target")"');
    expect(script).toContain('chmod 755 "$tmp"');
    expect(script).toContain('mv -f "$tmp" "$target"');
    expect(script).toContain("printf 'FS_RESULT %s %s\\n'");
    expect(script).toContain('trap');
  });

  it('guards create mode and appends without a rename', () => {
    const create = buildWriteScript({ path: '/root/work/new.txt', mode: 'create', createDirs: false });
    expect(create).toContain('if [ -e "$target" ]; then');
    expect(create).not.toContain('mkdir -p');

    const append = buildWriteScript({ path: '/root/work/new.txt', mode: 'append', createDirs: false });
    expect(append).toContain('cat "$tmp" >> "$target"');
    expect(append).not.toContain('mv -f "$tmp" "$target"');
  });

  it('keeps a backup copy when a suffix is given', () => {
    const script = buildWriteScript({
      path: '/root/work/app.sh',
      mode: 'overwrite',
      createDirs: false,
      backupSuffix: '.bak.1700000000000',
    });
    expect(script).toContain('cp -p "$target" "$target.bak.1700000000000"');
  });

  it('checks the syntax of scripts and json before the file is moved into place', () => {
    expect(syntaxCheckStatement('/root/work/app.sh')).toContain('bash -n "$tmp"');
    expect(syntaxCheckStatement('/root/work/app.py')).toContain('ast.parse');
    expect(syntaxCheckStatement('/root/work/config.json')).toContain('json.load');
    expect(syntaxCheckStatement('/root/work/notes.md')).toBeUndefined();

    const script = buildWriteScript({
      path: '/root/work/app.sh',
      mode: 'overwrite',
      createDirs: false,
      syntaxCheck: syntaxCheckStatement('/root/work/app.sh'),
    });
    expect(script.indexOf('bash -n "$tmp"')).toBeGreaterThan(script.indexOf('base64 -d > "$tmp"'));
    expect(script.indexOf('bash -n "$tmp"')).toBeLessThan(script.indexOf('mv -f "$tmp" "$target"'));
  });

  it('reads a whole file or a line window', () => {
    const whole = buildReadScript('/root/work/app.sh');
    expect(whole).toContain(FS_CONTENT_SENTINEL);
    expect(whole).toContain('cat "$target"');

    expect(buildReadScript('/root/work/app.sh', 5, 10)).toContain("sed -n '5,10p");
    expect(buildReadScript('/root/work/app.sh', 5)).toContain("sed -n '5,$p");
  });

  it('builds a short run command from the file extension', () => {
    expect(buildRunCommand('/root/work/app.sh')).toBe("bash '/root/work/app.sh'");
    expect(buildRunCommand('/root/work/app.py')).toBe("python3 '/root/work/app.py'");
    expect(buildRunCommand('/root/work/app.mjs')).toBe("node '/root/work/app.mjs'");
    expect(buildRunCommand('/root/work/app.sh', undefined, 'sh')).toBe("sh '/root/work/app.sh'");
    expect(buildRunCommand('/root/work/app.sh', 'bash /root/work/app.sh --dry-run')).toBe('bash /root/work/app.sh --dry-run');
    expect(() => buildRunCommand('/root/work/app.sh', undefined, 'bash; rm -rf /')).toThrow(/unsupported characters/);
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
  });
});

describe('runtime configuration and tool descriptors', () => {
  it('uses safe defaults', () => {
    const config = loadFsRuntimeConfig(env({}));
    expect(config.enabled).toBe(true);
    expect(config.allowedRoots).toEqual([]);
    expect(config.maxBytes).toBe(DEFAULT_FS_MAX_BYTES);
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
    const config = loadFsRuntimeConfig(env({}));
    const names = fsToolDefinitions(config).map((tool) => tool.name);
    expect(names).toEqual(['fs-write', 'fs-read', 'fs-patch', 'write-and-run']);
    expect(names.every((name) => isFsToolName(String(name)))).toBe(true);
    expect(isFsToolName('exec')).toBe(false);

    expect(fsToolDefinitions(loadFsRuntimeConfig(env({ SSH_MCP_FS_TOOLS_ENABLED: 'false' })))).toEqual([]);
  });

  it('keeps file bodies out of the audit log', () => {
    const redacted = redactFsArgs({ path: '/root/work/app.sh', content: 'secret body', old_str: 'a', new_str: 'b' });
    expect(redacted.path).toBe('/root/work/app.sh');
    expect(String(redacted.content)).toContain('11 chars');
    expect(String(redacted.content)).not.toContain('secret body');
    expect(String(redacted.old_str)).toContain('1 chars');
    expect(String(redacted.new_str)).toContain('1 chars');
  });
});
