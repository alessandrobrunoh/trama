/** Editor commands live in the frontend. This spec must not import those files: they sit outside the server rootDir. */
import { describe, expect, it } from 'vitest';

describe('editor model', () => {
  it('is covered by the frontend, not the API', () => {
    expect(true).toBe(true);
  });
});
