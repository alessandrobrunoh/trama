import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideBot,
  LucideBuilding2,
  LucideInbox,
  LucideDynamicIcon,
  LucideKeyRound,
  LucideBell,
  LucideDownload,
  LucideKeyboard,
  LucideShieldCheck,
  LucidePlug,
  LucideSlidersHorizontal,
  LucideSunMoon,
  LucideTriangleAlert,
  LucideUserRound,
  LucideUsers,
  LucideUsersRound,
  type LucideIcon,
} from '@lucide/angular';
import { NablaStore } from '../../core/stores/nabla.store';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { AgentsSection } from './sections/agents-section';
import { AiSection } from './sections/ai-section';
import { AppearanceSection } from './sections/appearance-section';
import { CustomerRequestsSection } from './sections/customer-requests-section';
import { ImportSection } from './sections/import-section';
import { IntegrationsSection } from './sections/integrations-section';
import { MembersSection } from './sections/members-section';
import { NotificationsSection } from './sections/notifications-section';
import { PreferencesSection } from './sections/preferences-section';
import { ProfileSection } from './sections/profile-section';
import { RolesSection } from './sections/roles-section';
import { ShortcutsSection } from './sections/shortcuts-section';
import { TeamsSection } from './sections/teams-section';
import { TokensSection } from './sections/tokens-section';
import { WorkspaceSection } from './sections/workspace-section';

interface Section {
  id: string;
  /** Nav label. */
  label: string;
  /** Page title (defaults to the label). */
  title?: string;
  icon: LucideIcon;
}

const GROUPS: { title: string; sections: Section[] }[] = [
  {
    title: 'Account',
    sections: [
      { id: 'profile', label: 'Profile', icon: LucideUserRound },
      { id: 'preferences', label: 'Preferences', icon: LucideSlidersHorizontal },
      { id: 'notifications', label: 'Notifications', icon: LucideBell },
      { id: 'ai', label: 'AI & assistant', icon: LucideBot },
      { id: 'appearance', label: 'Appearance', icon: LucideSunMoon },
      { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard shortcuts', icon: LucideKeyboard },
    ],
  },
  {
    title: 'Workspace',
    sections: [
      { id: 'workspace', label: 'General', title: 'Workspace', icon: LucideBuilding2 },
      { id: 'members', label: 'Members', icon: LucideUsers },
      { id: 'roles', label: 'Roles & permissions', icon: LucideShieldCheck },
      { id: 'teams', label: 'Teams', icon: LucideUsersRound },
      { id: 'agents', label: 'Agents', icon: LucideBot },
      { id: 'tokens', label: 'API tokens', icon: LucideKeyRound },
      { id: 'integrations', label: 'Integrations', icon: LucidePlug },
      { id: 'customer-requests', label: 'Customer requests', icon: LucideInbox },
      { id: 'import', label: 'Import', icon: LucideDownload },
    ],
  },
];
const ALL = GROUPS.flatMap((g) => g.sections);
/** Old / alternative section ids. */
const ALIASES: Record<string, string> = { danger: 'workspace', general: 'workspace', account: 'profile', theme: 'appearance' };

/**
 * Linear-style settings: grouped section nav on the left, centered content column on the right.
 * Every section is its own component in ./sections.
 */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    PageHeader,
    EmptyState,
    ProfileSection,
    PreferencesSection,
    NotificationsSection,
    AppearanceSection,
    ShortcutsSection,
    WorkspaceSection,
    MembersSection,
    RolesSection,
    TeamsSection,
    AgentsSection,
    AiSection,
    TokensSection,
    IntegrationsSection,
    CustomerRequestsSection,
    ImportSection,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header [title]="current()?.label ?? 'Settings'" />
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        class="scrollbar-none flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 md:w-56 md:flex-col md:gap-0 md:overflow-y-auto md:border-r md:border-b-0 md:px-3 md:py-6"
        aria-label="Settings sections"
      >
        @for (g of groups; track g.title; let first = $first) {
          <div class="text-muted-foreground hidden px-2 pb-1 text-xs font-medium md:block" [class.md:pt-5]="!first">{{ g.title }}</div>
          @for (s of g.sections; track s.id) {
            <a
              class="hover:bg-accent text-muted-foreground hover:text-foreground flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap transition-colors md:h-7 md:px-2 md:text-[13px]"
              [class.bg-accent]="sectionId() === s.id"
              [class.text-foreground]="sectionId() === s.id"
              [class.font-medium]="sectionId() === s.id"
              [attr.aria-current]="sectionId() === s.id ? 'page' : null"
              [routerLink]="['/', slug(), 'settings', s.id]"
            >
              <svg [lucideIcon]="s.icon" [size]="14" class="shrink-0"></svg>
              {{ s.label }}
            </a>
          }
        }
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
          @switch (sectionId()) {
            @case ('ai') { <app-ai-section /> }
            @case ('profile') {
              <app-profile-section />
            }
            @case ('notifications') {
              <app-notifications-section />
            }
            @case ('preferences') {
              <app-preferences-section />
            }
            @case ('appearance') {
              <app-appearance-section />
            }
            @case ('shortcuts') {
              <app-shortcuts-section />
            }
            @case ('workspace') {
              <app-workspace-section />
            }
            @case ('members') {
              <app-members-section />
            }
            @case ('roles') {
              <app-roles-section />
            }
            @case ('teams') {
              <app-teams-section />
            }
            @case ('agents') {
              <app-agents-section [agentId]="agent()" />
            }
            @case ('tokens') {
              <app-tokens-section [agentId]="agent()" />
            }
            @case ('integrations') {
              <app-integrations-section />
            }
            @case ('customer-requests') {
              <app-customer-requests-section />
            }
            @case ('import') {
              <app-import-section />
            }
            @default {
              <app-empty-state [icon]="warn" title="Unknown settings section" description="Pick a section from the list on the left." />
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class SettingsPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly section = input<string>();
  /** `?agent=<id>`: opens that agent (Agents) or preselects it when creating a token (API tokens). */
  readonly agent = input<string>();

  private readonly store = inject(NablaStore);

  protected readonly groups = GROUPS;
  protected readonly warn = LucideTriangleAlert;
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly sectionId = computed(() => {
    const id = this.section() ?? 'profile';
    return ALIASES[id] ?? id;
  });
  protected readonly current = computed(() => ALL.find((s) => s.id === this.sectionId()));
}
