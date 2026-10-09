import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ListQuery } from './notifications.controller.js';

const parse = async (query: Record<string, string>) => {
  const dto = plainToInstance(ListQuery, query);
  return { dto, errors: await validate(dto) };
};

describe('notifications list query', () => {
  it('reads unread=false as false (not as a truthy string)', async () => {
    const { dto, errors } = await parse({ unread: 'false' });
    expect(errors).toHaveLength(0);
    expect(dto.unread).toBe(false);
  });

  it('reads unread=true as true and leaves it undefined when absent', async () => {
    expect((await parse({ unread: 'true' })).dto.unread).toBe(true);
    expect((await parse({})).dto.unread).toBeUndefined();
  });

  it('rejects junk values', async () => {
    expect((await parse({ unread: 'maybe' })).errors).not.toHaveLength(0);
  });
});
