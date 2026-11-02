import { describe, expect, it } from 'vitest';
import { validateProfileName } from '../src/validation.js';

describe('validateProfileName', () => {
  it.each(['work', 'my-profile_2', 'A1', 'x'.repeat(64)])('accepts %s', name => {
    expect(validateProfileName(name).valid).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['  ', 'blank'],
    [' work', 'leading space'],
    ['work ', 'trailing space'],
    ['help', 'reserved'],
    ['VERSION', 'reserved (case-insensitive)'],
    ['../etc', 'traversal'],
    ['a/b', 'slash'],
    ['a\\b', 'backslash'],
    ['a b', 'space'],
    ['café', 'non-ascii'],
    ['x'.repeat(65), 'too long'],
  ])('rejects %j (%s)', name => {
    expect(validateProfileName(name).valid).toBe(false);
  });
});
