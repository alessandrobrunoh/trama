import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MAX_BODY_ARRAY, RejectUnsafeInputPipe, hasNulChar } from './configure-app.js';

class Dto {}

describe('RejectUnsafeInputPipe', () => {
  const pipe = new RejectUnsafeInputPipe();

  it('rejects a JSON array where a DTO is expected (PATCH /views/:id with [] used to 500 on Array.prototype.sort)', () => {
    expect(() => pipe.transform([], { type: 'body', metatype: Dto })).toThrow(BadRequestException);
    expect(() => pipe.transform([{ a: 1 }], { type: 'body', metatype: Dto })).toThrow(BadRequestException);
  });

  it('leaves objects, queries and params alone', () => {
    const body = { title: 'x' };
    expect(pipe.transform(body, { type: 'body', metatype: Dto })).toBe(body);
    expect(pipe.transform(['a'], { type: 'query', metatype: Dto })).toEqual(['a']);
    expect(pipe.transform(['a'], { type: 'body', metatype: Array })).toEqual(['a']);
  });
});

describe('NUL characters', () => {
  const pipe = new RejectUnsafeInputPipe();

  it('are a 400 in bodies and queries, at any depth (Postgres would answer 500)', () => {
    for (const bad of [{ title: 'a\u0000b' }, { a: { b: ['x', 'y\u0000'] } }, { 'k\u0000': 1 }]) {
      expect(() => pipe.transform(bad, { type: 'body', metatype: Dto })).toThrow(BadRequestException);
    }
    expect(() => pipe.transform({ q: '\u0000' }, { type: 'query', metatype: Dto })).toThrow(BadRequestException);
  });

  it('do not affect ordinary text, unicode or non-string values', () => {
    expect(hasNulChar({ title: 'caffè ☕', n: 1, ok: true, nothing: null, list: ['a', { b: 'c' }] })).toBe(false);
  });
});

describe('oversized lists', () => {
  const pipe = new RejectUnsafeInputPipe();
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id_${i}`);

  it('are a 400 at any depth (70k ids used to exceed the Postgres bind limit and answer 500)', () => {
    expect(() => pipe.transform({ teamIds: ids(MAX_BODY_ARRAY + 1) }, { type: 'body', metatype: Dto })).toThrow(BadRequestException);
    expect(() => pipe.transform({ a: { b: ids(70_000) } }, { type: 'body', metatype: Dto })).toThrow(BadRequestException);
  });

  it('allow a list at the limit', () => {
    const body = { teamIds: ids(MAX_BODY_ARRAY) };
    expect(pipe.transform(body, { type: 'body', metatype: Dto })).toBe(body);
  });
});
