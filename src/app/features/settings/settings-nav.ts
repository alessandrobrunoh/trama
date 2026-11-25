import {
  LucideBell,
  LucideBot,
  LucideDownload,
  LucideGauge,
  LucideKeyRound,
  LucideKeyboard,
  LucidePlug,
  LucideSettings,
  LucideShieldCheck,
  LucideSlidersHorizontal,
  LucideSparkles,
  LucideSunMoon,
  LucideTag,
  LucideTimer,
  LucideUserRound,
  LucideUsers,
  LucideWorkflow,
  type LucideIcon,
} from '@lucide/angular';

export interface SettingsSectionDef {
  /** Route segment: `/:ws/settings/:id`. */
  id: string;
  /** Sidebar label and breadcrumb. */
  label: string;
  icon: LucideIcon;
}

export interface SettingsGroupDef {
  /** Written uppercase, as the design does. */
  title: string;
  sections: readonly SettingsSectionDef[];
}

/** The settings sidebar (v3 "Settings sidebar"): WORKSPACE first, then ACCOUNT. */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  {
    title: 'WORKSPACE',
    sections: [
      { id: 'workspace', label: 'General', icon: LucideSettings },
      { id: 'workflow', label: 'Workflow', icon: LucideWorkflow },
      { id: 'estimates', label: 'Estimates', icon: LucideGauge },
      { id: 'members', label: 'Members', icon: LucideUsers },
      { id: 'roles', label: 'Roles & permissions', icon: LucideShieldCheck },
      { id: 'labels', label: 'Labels', icon: LucideTag },
      { id: 'agents', label: 'Agents', icon: LucideBot },
      { id: 'integrations', label: 'Integrations', icon: LucidePlug },
      { id: 'time', label: 'Time tracking', icon: LucideTimer },
      { id: 'import', label: 'Import', icon: LucideDownload },
    ],
  },
  {
    title: 'ACCOUNT',
    sections: [
      { id: 'profile', label: 'Profile', icon: LucideUserRound },
      { id: 'preferences', label: 'Preferences', icon: LucideSlidersHorizontal },
      { id: 'notifications', label: 'Notifications', icon: LucideBell },
      { id: 'ai', label: 'AI & assistant', icon: LucideSparkles },
      { id: 'appearance', label: 'Appearance', icon: LucideSunMoon },
      { id: 'shortcuts', label: 'Shortcuts', icon: LucideKeyboard },
      { id: 'api', label: 'API & MCP', icon: LucideKeyRound },
    ],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

/** Old / alternative section ids, still linked from elsewhere in the app. */
const ALIASES: Readonly<Record<string, string>> = {
  danger: 'workspace',
  general: 'workspace',
  account: 'profile',
  theme: 'appearance',
  statuses: 'workflow',
  tokens: 'api',
};

/** The section a route segment opens (an old id is mapped to its new home). */
export function resolveSettingsSection(raw: string | null | undefined): string {
  const id = raw ?? 'profile';
  return ALIASES[id] ?? id;
}

/** The section of a `/:ws/settings/:section` URL, or null when the URL is not a settings page. */
export function settingsSectionOfUrl(url: string): string | null {
  const [path] = url.split(/[?#]/);
  const segs = path.split('/').filter(Boolean);
  return segs[1] === 'settings' ? resolveSettingsSection(segs[2]) : null;
}
