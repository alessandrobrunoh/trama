import { describe, expect, it } from 'vitest';
import { WorkstreamEntity } from './index.js';

const row = (p: Partial<WorkstreamEntity>): WorkstreamEntity =>
  Object.assign(new WorkstreamEntity(), {
    id: 'wk_1',
    status: 'working',
    derivedStatus: 'working',
    statusOverride: null,
    legacyShipped: false,
    acceptanceCriteria: [{ id: 'c1', text: 'x', state: 'pending' }],
    ...p,
  });

describe('WorkstreamEntity wire format', () => {
  it('carries statusSource for derived, pinned and historic workstreams', () => {
    expect(row({}).toJSON().statusSource).toBe('derived');
    expect(row({ status: 'shipped', statusOverride: 'shipped' }).toJSON().statusSource).toBe('override');
    expect(row({ status: 'shipped', derivedStatus: 'shipped', legacyShipped: true, acceptanceCriteria: [] }).toJSON().statusSource).toBe('legacy');
  });

  it('keeps statusOverride off the wire when unset, as before', () => {
    expect(row({}).toJSON()).not.toHaveProperty('statusOverride');
  });
});
