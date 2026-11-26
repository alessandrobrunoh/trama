import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  cleanThreadPath,
  cleanThreadPaths,
  decisionMatchesPath,
  mergeFiles,
  pathMatches,
} from './thread-paths.js';

describe('pathMatches', () => {
  it('matches the file itself', () => {
    expect(pathMatches('src/auth/session.ts', 'src/auth/session.ts')).toBe(true);
    expect(pathMatches('src/auth/session.ts', 'src/auth/session.tsx')).toBe(false);
    expect(pathMatches('src/auth/session.ts', 'src/auth/other.ts')).toBe(false);
  });

  it('matches a directory prefix, with or without the trailing slash', () => {
    expect(pathMatches('src/auth/', 'src/auth/session.ts')).toBe(true);
    expect(pathMatches('src/auth', 'src/auth/token/refresh.ts')).toBe(true);
    expect(pathMatches('src/auth', 'src/auth')).toBe(true);
    expect(pathMatches('src/auth', 'src/authz/policy.ts')).toBe(false);
    expect(pathMatches('src/auth/token', 'src/auth/session.ts')).toBe(false);
  });

  it('keeps * inside one segment', () => {
    expect(pathMatches('src/auth/*', 'src/auth/session.ts')).toBe(true);
    expect(pathMatches('src/auth/*', 'src/auth/token/refresh.ts')).toBe(false);
    expect(pathMatches('src/*/session.ts', 'src/auth/session.ts')).toBe(true);
    expect(pathMatches('src/*/session.ts', 'src/auth/x/session.ts')).toBe(false);
    expect(pathMatches('*.md', 'README.md')).toBe(true);
    expect(pathMatches('*.md', 'docs/README.md')).toBe(false);
  });

  it('lets ** cross segments', () => {
    expect(pathMatches('src/auth/**', 'src/auth/token/refresh.ts')).toBe(true);
    expect(pathMatches('src/**/refresh.ts', 'src/auth/token/refresh.ts')).toBe(true);
    expect(pathMatches('src/**/refresh.ts', 'src/refresh.ts')).toBe(true);
    expect(pathMatches('**/*.spec.ts', 'server/src/a/b.spec.ts')).toBe(true);
    expect(pathMatches('**/*.spec.ts', 'b.spec.ts')).toBe(true);
    expect(pathMatches('src/auth/**', 'src/other/token.ts')).toBe(false);
  });

  it('treats regex characters in a path literally', () => {
    expect(pathMatches('src/a+b/(x).ts', 'src/a+b/(x).ts')).toBe(true);
    expect(pathMatches('src/*.ts', 'src/axts')).toBe(false);
  });

  it('ignores ./ and backslashes when comparing', () => {
    expect(pathMatches('./src/auth/', 'src/auth/session.ts')).toBe(true);
    expect(pathMatches('src\\auth\\*', 'src/auth/session.ts')).toBe(true);
    expect(pathMatches('src/auth/*', './src/auth/session.ts')).toBe(true);
  });
});

describe('decisionMatchesPath', () => {
  it('matches when any path does, and never without paths', () => {
    expect(decisionMatchesPath(['docs/', 'src/auth/*'], 'src/auth/session.ts')).toBe(true);
    expect(decisionMatchesPath(['docs/', 'src/db/*'], 'src/auth/session.ts')).toBe(false);
    expect(decisionMatchesPath([], 'src/auth/session.ts')).toBe(false);
  });
});

describe('cleanThreadPath', () => {
  it('trims and keeps the rest as given', () => {
    expect(cleanThreadPath('  src/auth/*  ')).toBe('src/auth/*');
    expect(cleanThreadPath('src/auth/')).toBe('src/auth/');
  });

  it('refuses absolute paths, .. segments, empty and oversized paths', () => {
    for (const bad of [
      '',
      '   ',
      '/etc/passwd',
      '\\windows\\system32',
      'C:\\temp\\x',
      '~/secrets',
      '../outside',
      'src/../../outside',
      'src\\..\\x',
      `src/${'a'.repeat(600)}`,
    ])
      expect(() => cleanThreadPath(bad), bad).toThrow(BadRequestException);
    expect(cleanThreadPath('src/..hidden/file')).toBe('src/..hidden/file');
  });

  it('cleans a list and drops duplicates', () => {
    expect(cleanThreadPaths([' a.ts', 'b.ts', 'a.ts '])).toEqual(['a.ts', 'b.ts']);
  });
});

describe('mergeFiles', () => {
  it('puts the new files first, keeps the old ones after, without duplicates', () => {
    expect(mergeFiles(['old.ts', 'shared.ts'], ['new.ts', 'shared.ts'], 10)).toEqual([
      'new.ts',
      'shared.ts',
      'old.ts',
    ]);
  });

  it('keeps the record as it is when nothing new is sent', () => {
    expect(mergeFiles(['a.ts', 'b.ts'], [], 10)).toEqual(['a.ts', 'b.ts']);
  });

  it('caps the list, dropping the oldest', () => {
    expect(mergeFiles(['c.ts', 'd.ts'], ['a.ts', 'b.ts'], 3)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
