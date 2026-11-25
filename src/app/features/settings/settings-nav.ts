import {
  LucideBell,
  LucideBot,
  LucideDownload,
  LucideGauge,
  LucideKeyRound,
  LucideKeyboard,
  LucidePlug,
  LucidePlugZap,
  LucideSettings,
  LucideShieldCheck,
  LucideSlidersHorizontal,
  LucideSparkles,
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

/** The settings sidebar (v4 "Settings sidebar"): WORKSPACE first, then ACCOUNT, in the order of the frames. */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  {
    title: 'WORKSPACE',
    sections: [
      { id: 'workspace', label: 'General', icon: LucideSettings },
      { id: 'members', label: 'Members', icon: LucideUsers },
      { id: 'roles', label: 'Roles & permissions', icon: LucideShieldCheck },
      { id: 'workflow', label: 'Workflow', icon: LucideWorkflow },
      { id: 'labels', label: 'Labels', icon: LucideTag },
      { id: 'estimates', label: 'Estimates', icon: LucideGauge },
      { id: 'time', label: 'Time tracking', icon: LucideTimer },
      { id: 'integrations', label: 'Integrations', icon: LucidePlug },
      { id: 'agents', label: 'Agents', icon: LucideBot },
      { id: 'import', label: 'Import', icon: LucideDownload },
    ],
  },
  {
    title: 'ACCOUNT',
    sections: [
      { id: 'profile', label: 'Profile', icon: LucideUserRound },
      { id: 'my-integrations', label: 'Integrations', icon: LucidePlugZap },
      { id: 'preferences', label: 'Preferences', icon: LucideSlidersHorizontal },
      { id: 'notifications', label: 'Notifications', icon: LucideBell },
      { id: 'ai', label: 'AI & assistant', icon: LucideSparkles },
      { id: 'shortcuts', label: 'Shortcuts', icon: LucideKeyboard },
      { id: 'api', label: 'API tokens', icon: LucideKeyRound },
    ],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

/** Old / alternative section ids, still linked from elsewhere in the app. */
const ALIASES: Readonly<Record<string, string>> = {
  danger: 'workspace',
  general: 'workspace',
  account: 'profile',
  theme: 'preferences',
  appearance: 'preferences',
  personal: 'my-integrations',
  'personal-integrations': 'my-integrations',
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
