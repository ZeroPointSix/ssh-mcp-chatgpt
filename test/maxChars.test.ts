import { describe, it, expect } from 'vitest';
import { resolveMaxChars, sanitizeCommandWithMaxChars } from '../src/index';

describe('maxChars configuration', () => {
  describe('default and no-limit behavior', () => {
    it('defaults to unlimited when unset', () => {
      expect(resolveMaxChars(undefined)).toBe(Infinity);
      expect(resolveMaxChars(null)).toBe(Infinity);
    });

    it('allows unlimited characters with maxChars=none', () => {
      expect(resolveMaxChars('none')).toBe(Infinity);
      expect(resolveMaxChars('NONE')).toBe(Infinity);
    });

    it('allows unlimited characters with maxChars=0 or negative values', () => {
      expect(resolveMaxChars('0')).toBe(Infinity);
      expect(resolveMaxChars('-1')).toBe(Infinity);
    });

    it('falls back to unlimited for invalid string values', () => {
      expect(resolveMaxChars('invalid')).toBe(Infinity);
    });
  });

  describe('custom maxChars limit', () => {
    it('respects custom positive limits', () => {
      const longCommand = 'echo ' + 'x'.repeat(50);
      const maxChars = resolveMaxChars('50');

      expect(maxChars).toBe(50);
      expect(() => sanitizeCommandWithMaxChars(longCommand, maxChars)).toThrow(
        'Command is too long (max 50 characters)',
      );
    });

    it('does not reject commands over 1000 characters by default', () => {
      const longCommand = 'echo ' + 'x'.repeat(1000);

      expect(() => sanitizeCommandWithMaxChars(longCommand, resolveMaxChars(undefined))).not.toThrow();
      expect(sanitizeCommandWithMaxChars(longCommand, resolveMaxChars(undefined))).toBe(longCommand);
    });
  });
});
