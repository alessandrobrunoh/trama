import { guestMayOpenSettings, settingsGroupsFor } from '../features/settings/settings-nav';
import { ALL_NAV, MORE_NAV, PRIMARY_NAV, guestMayOpen, navForRole } from './nav';

describe('what a guest gets in the app', () => {
  it('keeps everything for everyone else', () => {
    expect(navForRole(ALL_NAV, false).map((n) => n.segment)).toEqual(ALL_NAV.map((n) => n.segment));
  });

  it('hides the workspace-wide places and keeps the work', () => {
    const segments = navForRole(ALL_NAV, true).map((n) => n.segment);
    for (const hidden of ['assistant', 'views', 'stats', 'connect']) expect(segments).not.toContain(hidden);
    for (const shown of ['inbox', 'my-tasks', 'tasks', 'board', 'projects', 'timeline', 'timer'])
      expect(segments).toContain(shown);
  });

  it('filters the two sidebar lists independently', () => {
    expect(navForRole(PRIMARY_NAV, true).some((n) => n.segment === 'assistant')).toBe(false);
    expect(navForRole(MORE_NAV, true).some((n) => n.segment === 'connect')).toBe(false);
  });

  it('opens a path segment unless it is one of the hidden ones', () => {
    expect(guestMayOpen('tasks')).toBe(true);
    expect(guestMayOpen('settings')).toBe(true);
    expect(guestMayOpen('views')).toBe(false);
    expect(guestMayOpen(undefined)).toBe(true);
  });

  it('settings: only the personal sections', () => {
    const ids = settingsGroupsFor(true).flatMap((g) => g.sections.map((s) => s.id));
    expect(ids).toEqual(['profile', 'my-integrations', 'preferences', 'notifications', 'shortcuts']);
    expect(settingsGroupsFor(true).map((g) => g.title)).toEqual(['ACCOUNT']);
    expect(guestMayOpenSettings('members')).toBe(false);
    expect(guestMayOpenSettings('api')).toBe(false);
    expect(guestMayOpenSettings('ai')).toBe(false);
  });

  it('settings: everyone else keeps every section', () => {
    expect(settingsGroupsFor(false).map((g) => g.title)).toEqual(['WORKSPACE', 'ACCOUNT']);
  });
});
