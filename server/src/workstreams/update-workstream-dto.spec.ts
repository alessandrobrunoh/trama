import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { UpdateWorkstreamDto } from './workstreams.controller.js';

const errors = async (body: Record<string, unknown>) => validate(plainToInstance(UpdateWorkstreamDto, body), { whitelist: true });

describe('UpdateWorkstreamDto.deltaThreadUrl', () => {
  it('accepts an empty string, so a thread can be removed', async () => {
    expect(await errors({ deltaThreadUrl: '' })).toHaveLength(0);
    expect(await errors({ deltaThreadUrl: 'https://delta.dev/t/abc' })).toHaveLength(0);
  });

  it('still rejects null and non-strings', async () => {
    expect(await errors({ deltaThreadUrl: null })).not.toHaveLength(0);
    expect(await errors({ deltaThreadUrl: 5 })).not.toHaveLength(0);
  });
});
