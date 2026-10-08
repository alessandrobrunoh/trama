import { describe, expect, it } from 'vitest';
import {
  LABEL_TEMPLATES,
  adoptFreeTextLabels,
  assignLabelIds,
  resolveLabelCatalog,
} from '../contracts/domain.js';

describe('workspace labels', () => {
  it('always offers the four templates, and keeps a saved template color', () => {
    const catalog = resolveLabelCatalog([
      { id: 'lb_bug', name: 'Renamed', color: '#111111', template: true },
      { id: 'lb_custom', name: 'Auth', color: '#334455', template: false },
    ]);
    expect(catalog.map((label) => label.name)).toEqual(['Bug', 'Feature', 'Improvement', 'Documentation', 'Auth']);
    expect(catalog[0].color).toBe('#111111');
    expect(catalog[0].template).toBe(true);
  });

  it('turns free text into ids and reuses a template name', () => {
    const { catalog, groups, lookup } = adoptFreeTextLabels(undefined, [['Bug', 'auth'], ['auth', 'auth']]);
    expect(groups[0][0]).toBe('lb_bug');
    expect(groups[1]).toEqual([groups[0][1]]);
    expect(lookup.get('auth')).toBe(groups[0][1]);
    expect(catalog.find((label) => label.id === groups[0][1])?.name).toBe('auth');
    expect(catalog.filter((label) => label.template)).toEqual(LABEL_TEMPLATES.map((label) => ({ ...label })));
  });

  it('rejects an id that is not in the catalog', () => {
    expect(() => assignLabelIds(resolveLabelCatalog(null), ['lb_missing'])).toThrow(/Unknown label/);
    expect(assignLabelIds(resolveLabelCatalog(null), ['lb_bug', 'lb_bug'])).toEqual(['lb_bug']);
  });
});
