import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { matchesFilter } from './view-query.js';
import { CreateViewDto } from './views.controller.js';

const errorsFor = async (value: unknown) =>
  validate(plainToInstance(CreateViewDto, { name: 'v', entity: 'issue', filters: [{ field: 'title', op: 'contains', value }] }), {
    whitelist: true,
  });

describe('saved view filter values', () => {
  it('accepts a string and a list of strings', async () => {
    expect(await errorsFor('bug')).toHaveLength(0);
    expect(await errorsFor(['a', 'b'])).toHaveLength(0);
    expect(await errorsFor('')).toHaveLength(0);
  });

  it.each([5, null, { a: 1 }, [1, 2], true])('rejects %j (it would crash the public link evaluator)', async (value) => {
    expect(await errorsFor(value)).not.toHaveLength(0);
  });
});

describe('legacy filter values', () => {
  it('never throw in the evaluator', () => {
    const row = { title: 'Fix 5 bugs' };
    expect(matchesFilter('issue', row, { field: 'title', op: 'contains', value: 5 as never })).toBe(true);
    expect(matchesFilter('issue', row, { field: 'title', op: 'contains', value: null as never })).toBe(true);
    expect(matchesFilter('issue', row, { field: 'title', op: 'is', value: 7 as never })).toBe(false);
  });
});
