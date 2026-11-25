import { SETTINGS_SECTIONS, resolveSettingsSection, settingsSectionOfUrl } from './settings-nav';

describe('settings nav', () => {
  it('opens Profile when the URL has no section', () => {
    expect(resolveSettingsSection(undefined)).toBe('profile');
    expect(resolveSettingsSection(null)).toBe('profile');
  });

  it('maps old section ids to their new pages', () => {
    expect(resolveSettingsSection('tokens')).toBe('api');
    expect(resolveSettingsSection('statuses')).toBe('workflow');
    expect(resolveSettingsSection('danger')).toBe('workspace');
  });

  it('keeps a current id as it is', () => {
    for (const s of SETTINGS_SECTIONS) expect(resolveSettingsSection(s.id)).toBe(s.id);
  });

  it('reads the section out of a settings URL', () => {
    expect(settingsSectionOfUrl('/acme/settings/workflow')).toBe('workflow');
    expect(settingsSectionOfUrl('/acme/settings/tokens?agent=ag_1')).toBe('api');
    expect(settingsSectionOfUrl('/acme/settings')).toBe('profile');
  });

  it('is null away from settings', () => {
    expect(settingsSectionOfUrl('/acme/tasks')).toBeNull();
    expect(settingsSectionOfUrl('/')).toBeNull();
  });

  it('has no duplicate ids', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
