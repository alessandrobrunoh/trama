import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertThreadLinkable } from '../issues/thread-link.js';
import { cleanSyncInput } from './threads.service.js';

describe('cleanSyncInput', () => {
  it('trims everything and drops duplicate paths', () => {
    expect(
      cleanSyncInput({
        summary: '  Done  ',
        decisions: [{ text: ' Keep it simple ', paths: [' src/a.ts', 'src/a.ts', 'docs/'] }, { text: 'No paths' }],
        files: ['b.ts ', 'b.ts'],
        activeMinutes: 12,
      }),
    ).toEqual({
      threadUrl: undefined,
      summary: 'Done',
      decisions: [
        { text: 'Keep it simple', paths: ['src/a.ts', 'docs/'] },
        { text: 'No paths', paths: [] },
      ],
      files: ['b.ts'],
      pullRequestUrl: undefined,
      activeMinutes: 12,
      turns: undefined,
    });
  });

  it('leaves a missing summary alone and turns an empty one into null', () => {
    expect(cleanSyncInput({}).summary).toBeUndefined();
    expect(cleanSyncInput({ summary: '   ' }).summary).toBeNull();
  });

  it('refuses a blank decision and unsafe paths', () => {
    expect(() => cleanSyncInput({ decisions: [{ text: '  ' }] })).toThrow(BadRequestException);
    expect(() => cleanSyncInput({ files: ['/etc/passwd'] })).toThrow(BadRequestException);
    expect(() => cleanSyncInput({ decisions: [{ text: 'x', paths: ['../x'] }] })).toThrow(BadRequestException);
  });
});

describe('assertThreadLinkable', () => {
  const A = 'https://delta.dev/t/a';
  const B = 'https://delta.dev/t/b';

  it('allows a first link, the same link again and unlinking', () => {
    expect(() => assertThreadLinkable('TRM-1', null, A)).not.toThrow();
    expect(() => assertThreadLinkable('TRM-1', undefined, A)).not.toThrow();
    expect(() => assertThreadLinkable('TRM-1', A, A)).not.toThrow();
    expect(() => assertThreadLinkable('TRM-1', A, null)).not.toThrow();
    expect(() => assertThreadLinkable('TRM-1', A, undefined)).not.toThrow();
  });

  it('refuses a different thread with the current one in the body', () => {
    try {
      assertThreadLinkable('TRM-1', A, B);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const res = (error as ConflictException).getResponse();
      expect(res).toMatchObject({ code: 'thread_already_linked', threadUrl: A });
      expect((error as ConflictException).getStatus()).toBe(409);
    }
  });
});
