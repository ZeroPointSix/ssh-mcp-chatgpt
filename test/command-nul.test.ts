import { describe, it, expect } from 'vitest';
import { sanitizeCommandWithMaxChars } from '../src/index';
const nul = String.fromCharCode(0);
describe('NUL command validation', () => {
  it.each([nul + 'echo ok', 'echo' + nul + ' ok', 'echo ok' + nul])('rejects NUL before SSH transport: %j', (command) => {
    expect(() => sanitizeCommandWithMaxChars(command, Infinity)).toThrow('Command cannot contain NUL characters');
  });
  it('preserves ordinary commands and length validation', () => {
    expect(sanitizeCommandWithMaxChars('  echo ok  ', 7)).toBe('echo ok');
    expect(() => sanitizeCommandWithMaxChars('echo longer', 7)).toThrow('Command is too long');
    expect(() => sanitizeCommandWithMaxChars('   ', Infinity)).toThrow('Command cannot be empty');
  });
});
