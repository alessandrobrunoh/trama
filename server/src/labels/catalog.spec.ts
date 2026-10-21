import { describe, expect, it } from 'vitest';
import {
  LABEL_TEMPLATES,
  adoptFreeTextLabels,
  assignLabelIds,
  resolveLabelCatalog,
} from '../contracts/domain.js';

describe('workspace labels', () => {
  it('starts without type labels and keeps a legacy type label as a custom label', () => {
    expect(resolveLabelCatalog()).toEqual([]);
    const catalog = resolveLabelCatalog([
      {
        id: 'lb_bug',
        name: 'Bug',
        color: '#111111',
        template: false,
        scope: 'issue',
      },
      {
        id: 'lb_custom',
        name: 'Auth',
        color: '#334455',
        template: false,
        scope: 'issue',
      },
      {
        id: 'lb_road',
        name: 'Roadmap',
        color: '#0891b2',
        template: false,
        scope: 'project',
      },
      {
        id: 'lb_bad',
        name: 'Nope',
        color: '#0891b2',
        template: false,
        scope: 'elsewhere' as 'issue',
      },
    ]);
    expect(catalog.map((label) => label.name)).toEqual(['Bug', 'Auth', 'Roadmap', 'Nope']);
    expect(catalog.find((label) => label.id === 'lb_bug')).toMatchObject({
      color: '#111111',
      template: false,
      scope: 'issue',
      name: 'Bug',
    });
    expect(catalog.find((label) => label.id === 'lb_custom')?.scope).toBe(
      'issue',
    );
    expect(catalog.find((label) => label.id === 'lb_road')?.scope).toBe(
      'project',
    );
    expect(catalog.find((label) => label.id === 'lb_bad')?.scope).toBe('issue');
  });

  it('turns free text into custom ids, including names formerly supplied as templates', () => {
    const { catalog, groups, lookup } = adoptFreeTextLabels(undefined, [
      { scope: 'issue', labels: ['Bug', 'auth'] },
      { scope: 'issue', labels: ['auth', 'auth'] },
    ]);
    expect(groups[0][0]).toBe('lb_bug');
    expect(groups[1]).toEqual([groups[0][1]]);
    expect(lookup.get('auth')).toBe(groups[0][1]);
    expect(catalog.find((label) => label.id === 'lb_bug')).toMatchObject({
      name: 'Bug',
      template: false,
    });
    expect(catalog.find((label) => label.id === groups[0][1])?.name).toBe(
      'auth',
    );
    expect(catalog.filter((label) => label.template)).toEqual(
      LABEL_TEMPLATES.map((label) => ({ ...label })),
    );
  });

  it('gives each new free-text label the scope of its own group', () => {
    const { catalog, groups } = adoptFreeTextLabels(undefined, [
      { scope: 'issue', labels: ['auth'] },
      { scope: 'project', labels: ['auth', 'launch'] },
    ]);
    expect(catalog.find((label) => label.name === 'auth')).toMatchObject({
      scope: 'issue',
    });
    expect(catalog.find((label) => label.name === 'launch')).toMatchObject({
      scope: 'project',
    });
    expect(groups[1][0]).toBe(groups[0][0]);
  });

  it('rejects an unknown id, a label from another scope, and more than 20', () => {
    const catalog = resolveLabelCatalog([
      {
        id: 'lb_bug',
        name: 'Bug',
        color: '#e11d48',
        template: false,
        scope: 'issue',
      },
      {
        id: 'lb_road',
        name: 'Roadmap',
        color: '#334455',
        template: false,
        scope: 'project',
      },
      ...Array.from({ length: 21 }, (_, i) => ({
        id: `lb_${i}`,
        name: `L${i}`,
        color: '#334455',
        template: false as const,
        scope: 'issue' as const,
      })),
    ]);
    expect(() => assignLabelIds(catalog, ['lb_missing'], 'issue')).toThrow(
      /Unknown label/,
    );
    expect(assignLabelIds(catalog, ['lb_bug', 'lb_bug'], 'issue')).toEqual([
      'lb_bug',
    ]);
    expect(() => assignLabelIds(catalog, ['lb_road'], 'issue')).toThrow(
      /does not apply to issues/,
    );
    expect(
      assignLabelIds(catalog, ['lb_bug', 'lb_road'], 'issue', ['lb_road']),
    ).toEqual(['lb_bug', 'lb_road']);
    expect(() => assignLabelIds(catalog, ['lb_bug'], null)).toThrow(
      /does not apply to this record/,
    );
    expect(assignLabelIds(catalog, ['lb_bug'], null, ['lb_bug'])).toEqual([
      'lb_bug',
    ]);
    const issueIds = catalog
      .filter((label) => label.scope === 'issue' && !label.template)
      .map((label) => label.id);
    expect(() =>
      assignLabelIds(catalog, issueIds.slice(0, 21), 'issue'),
    ).toThrow(/at most 20/);
  });
});
