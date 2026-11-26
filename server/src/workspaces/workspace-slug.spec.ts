import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, SLUG_MAX, SLUG_RE, baseSlug, freeSlug, slugWithSuffix } from './workspace-slug.js';

describe('baseSlug', () => {
  it('derives a lowercase slug from a name', () => {
    expect(baseSlug('Alessandro Bruno')).toBe('alessandro-bruno');
    expect(baseSlug('  Grace   Hopper!  ')).toBe('grace-hopper');
  });

  it('never returns a reserved or too short slug', () => {
    for (const reserved of ['Admin', 'Settings', 'Login'])
      expect(RESERVED_SLUGS.has(baseSlug(reserved))).toBe(false);
    expect(baseSlug('Admin')).toBe('admin-ws');
    expect(baseSlug('Al')).toBe('al-ws');
    expect(SLUG_RE.test(baseSlug('Al'))).toBe(true);
  });

  it('falls back when the name has no usable characters', () => {
    expect(baseSlug('!!!', 'personal')).toBe('personal');
    expect(baseSlug('日本語')).toBe('workspace');
  });

  it('stays within the slug length even with the reserved suffix', () => {
    const long = baseSlug('a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(SLUG_RE.test(long)).toBe(true);
  });
});

describe('freeSlug', () => {
  it('appends a counter until the slug is free', () => {
    const taken = new Set(['ada', 'ada-2']);
    expect(freeSlug('Ada', (slug) => taken.has(slug))).toBe('ada-3');
    expect(freeSlug('Grace Hopper', (slug) => taken.has(slug))).toBe('grace-hopper');
  });

  it('trims the root so the suffix still fits', () => {
    const name = 'b'.repeat(40);
    const taken = new Set([name]);
    const next = freeSlug(name, (slug) => taken.has(slug));
    expect(next.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(next.endsWith('-2')).toBe(true);
    expect(slugWithSuffix(name, 12).length).toBeLessThanOrEqual(SLUG_MAX);
  });
});
