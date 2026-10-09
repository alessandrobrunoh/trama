import { describe, expect, it } from 'vitest';
import { scopedKey, workspaceSlugOf } from '../../../src/app/core/stores/list-state-scope.ts';

describe('workspaceSlugOf / scopedKey', () => {
  it('reads the workspace out of router URLs', () => {
    expect(workspaceSlugOf('/acme/issues')).toBe('acme');
    expect(workspaceSlugOf('/globex/issues?team=x#top')).toBe('globex');
    expect(workspaceSlugOf('/my%20team/overview')).toBe('my team');
    expect(workspaceSlugOf('/')).toBeNull();
    expect(workspaceSlugOf('')).toBeNull();
  });

  it('gives each workspace its own copy of a key', () => {
    expect(scopedKey('acme', 'issues.filters')).not.toBe(scopedKey('globex', 'issues.filters'));
    expect(scopedKey(null, 'k')).toBe('::k');
  });
});
