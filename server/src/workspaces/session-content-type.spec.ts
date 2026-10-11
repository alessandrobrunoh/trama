import { describe, expect, it } from 'vitest';
import { sessionAllowsContentType } from './access.guard.js';

describe('session content type', () => {
  it('keeps JSON for ordinary writes and allows multipart only on an upload route', () => {
    expect(
      sessionAllowsContentType({
        hasBody: true,
        json: true,
        multipart: false,
        multipartRoute: false,
      }),
    ).toBe(true);
    expect(
      sessionAllowsContentType({
        hasBody: true,
        json: false,
        multipart: true,
        multipartRoute: false,
      }),
    ).toBe(false);
    expect(
      sessionAllowsContentType({
        hasBody: true,
        json: false,
        multipart: true,
        multipartRoute: true,
      }),
    ).toBe(true);
    expect(
      sessionAllowsContentType({
        hasBody: true,
        json: false,
        multipart: false,
        multipartRoute: true,
      }),
    ).toBe(false);
    expect(
      sessionAllowsContentType({
        hasBody: false,
        json: false,
        multipart: false,
        multipartRoute: false,
      }),
    ).toBe(true);
  });
});
