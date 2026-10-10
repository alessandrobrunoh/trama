import { describe, expect, it } from 'vitest';
import { statusSourceInfo } from '../../../src/app/features/workstreams/status-source.ts';

describe('statusSourceInfo (badge in the workstream list and detail)', () => {
  it('names a pin and says what the facts say', () => {
    const i = statusSourceInfo({ statusSource: 'override', derivedStatus: 'working' });
    expect(i.label).toBe('pinned');
    expect(i.hint).toContain('not proof');
    expect(i.hint).toContain('Working');
  });

  it('names a historic shipped as unproven', () => {
    const i = statusSourceInfo({ statusSource: 'legacy', derivedStatus: 'shipped' });
    expect(i.label).toBe('historic');
    expect(i.hint).toContain('Nothing proves the outcome');
  });

  it('calls a derived status derived', () => {
    expect(statusSourceInfo({ statusSource: 'derived', derivedStatus: 'working' }).label).toBe('derived');
  });
});
