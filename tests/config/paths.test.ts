import { describe, expect, test } from 'bun:test';
import { homebrewPrefixFromExecutable } from '../../src/config/paths.ts';

describe('homebrewPrefixFromExecutable', () => {
  test('derives Apple Silicon Homebrew prefix from Cellar executable', () => {
    expect(homebrewPrefixFromExecutable('/opt/homebrew/Cellar/acmos/0.1.6/bin/acmos')).toBe(
      '/opt/homebrew',
    );
  });

  test('derives Intel Homebrew prefix from Cellar executable', () => {
    expect(homebrewPrefixFromExecutable('/usr/local/Cellar/acmos/0.1.6/bin/acmos')).toBe(
      '/usr/local',
    );
  });

  test('ignores source and unrelated executable paths', () => {
    expect(homebrewPrefixFromExecutable('/Users/didi/github/acmos/dist/acmos')).toBeUndefined();
  });
});
