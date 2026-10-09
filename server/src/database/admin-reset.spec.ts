import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from './admin.controller.js';
import { adminResetEnabled } from './admin-reset.js';
import type { SeedService } from './seed/seed.service.js';

describe('adminResetEnabled', () => {
  it('is off by default, whatever NODE_ENV says', () => {
    expect(adminResetEnabled({})).toBe(false);
    expect(adminResetEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(adminResetEnabled({ NODE_ENV: 'test' })).toBe(false);
  });

  it('needs the exact flag value true', () => {
    expect(adminResetEnabled({ TRAMA_ENABLE_ADMIN_RESET: '1' })).toBe(false);
    expect(adminResetEnabled({ TRAMA_ENABLE_ADMIN_RESET: 'false' })).toBe(false);
    expect(adminResetEnabled({ NODE_ENV: 'test', TRAMA_ENABLE_ADMIN_RESET: 'true' })).toBe(true);
    expect(adminResetEnabled({ TRAMA_ENABLE_ADMIN_RESET: 'true' })).toBe(true);
  });

  it('is never on in production, even with the flag', () => {
    expect(adminResetEnabled({ NODE_ENV: 'production', TRAMA_ENABLE_ADMIN_RESET: 'true' })).toBe(false);
  });
});

describe('AdminController.reset', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('404s and does not touch the database when disabled', async () => {
    const seed = { reset: vi.fn().mockResolvedValue(undefined) };
    const controller = new AdminController(seed as unknown as SeedService);
    vi.stubEnv('TRAMA_ENABLE_ADMIN_RESET', '');
    await expect(controller.reset()).rejects.toBeInstanceOf(NotFoundException);
    expect(seed.reset).not.toHaveBeenCalled();
  });

  it('resets when the flag is on outside production', async () => {
    const seed = { reset: vi.fn().mockResolvedValue(undefined) };
    const controller = new AdminController(seed as unknown as SeedService);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('TRAMA_ENABLE_ADMIN_RESET', 'true');
    await expect(controller.reset()).resolves.toEqual({ ok: true });
    expect(seed.reset).toHaveBeenCalledOnce();
  });
});
