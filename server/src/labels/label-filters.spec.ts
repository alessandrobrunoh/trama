import { describe, expect, it } from 'vitest';
import { replaceLabelId, resolveLabelCatalog } from '../contracts/domain.js';
import { rewriteLabelFilters } from './label-filters.js';

describe('replaceLabelId', () => {
  it('merges into the target without listing it twice, keeping order', () => {
    expect(replaceLabelId(['lb_a', 'lb_b', 'lb_c'], 'lb_a', 'lb_c')).toEqual(['lb_c', 'lb_b']);
    expect(replaceLabelId(['lb_a', 'lb_b'], 'lb_a', 'lb_z')).toEqual(['lb_z', 'lb_b']);
  });

  it('removes the id when there is no target', () => {
    expect(replaceLabelId(['lb_a', 'lb_b'], 'lb_a', null)).toEqual(['lb_b']);
    expect(replaceLabelId(['lb_b'], 'lb_a', null)).toEqual(['lb_b']);
  });
});

describe('rewriteLabelFilters', () => {
  it('leaves filters that do not mention the label alone', () => {
    expect(rewriteLabelFilters([{ field: 'labels', op: 'in', value: ['lb_x'] }, { field: 'status', op: 'is', value: 'lb_a' }], 'lb_a', null)).toBeNull();
    expect(rewriteLabelFilters(null, 'lb_a', 'lb_b')).toBeNull();
  });

  it('replaces the id on a merge and dedupes', () => {
    expect(rewriteLabelFilters([{ field: 'labels', op: 'in', value: ['lb_a', 'lb_b'] }], 'lb_a', 'lb_b')).toEqual([
      { field: 'labels', op: 'in', value: ['lb_b'] },
    ]);
    expect(rewriteLabelFilters([{ field: 'labels', op: 'is', value: 'lb_a' }], 'lb_a', 'lb_b')).toEqual([{ field: 'labels', op: 'is', value: 'lb_b' }]);
  });

  it('drops a filter that would be left empty on delete, keeps the others', () => {
    expect(
      rewriteLabelFilters(
        [
          { field: 'status', op: 'is', value: 'todo' },
          { field: 'labels', op: 'in', value: ['lb_a'] },
          { field: 'labels', op: 'not_in', value: ['lb_a', 'lb_b'] },
        ],
        'lb_a',
        null,
      ),
    ).toEqual([
      { field: 'status', op: 'is', value: 'todo' },
      { field: 'labels', op: 'not_in', value: ['lb_b'] },
    ]);
  });
});

describe('archived labels', () => {
  it('keeps the flag on custom labels only', () => {
    const catalog = resolveLabelCatalog([
      { id: 'lb_bug', name: 'Bug', color: '#e11d48', template: true, archived: true },
      { id: 'lb_old', name: 'Old', color: '#334455', template: false, archived: true },
      { id: 'lb_new', name: 'New', color: '#334455', template: false },
    ]);
    expect(catalog.find((label) => label.id === 'lb_bug')?.archived).toBeUndefined();
    expect(catalog.find((label) => label.id === 'lb_old')?.archived).toBe(true);
    expect(catalog.find((label) => label.id === 'lb_new')).not.toHaveProperty('archived');
  });
});
