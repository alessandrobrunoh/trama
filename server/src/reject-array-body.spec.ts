import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RejectArrayBodyPipe } from './configure-app.js';

class Dto {}

describe('RejectArrayBodyPipe', () => {
  const pipe = new RejectArrayBodyPipe();

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
