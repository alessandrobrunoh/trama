import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideTriangleAlert } from '@lucide/angular';
import { usePageCrumbs } from '../../layout/page-chrome';
import { TramaStore } from '../../core/stores/trama.store';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { AgentsSection } from './sections/agents-section';
import { AiSection } from './sections/ai-section';
import { ApiSection } from './sections/api-section';
import { AppearanceSection } from './sections/appearance-section';
import { EstimatesSection } from './sections/estimates-section';
import { ImportSection } from './sections/import-section';
import { IntegrationsSection } from './sections/integrations-section';
import { LabelsSection } from './sections/labels-section';
import { MembersSection } from './sections/members-section';
import { NotificationsSection } from './sections/notifications-section';
import { PersonalIntegrationsSection } from './sections/personal-integrations-section';
import { PreferencesSection } from './sections/preferences-section';
import { ProfileSection } from './sections/profile-section';
import { RolesSection } from './sections/roles-section';
import { ShortcutsSection } from './sections/shortcuts-section';
import { TimeSection } from './sections/time-section';
import { WorkflowSection } from './sections/workflow-section';
import { WorkspaceSection } from './sections/workspace-section';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, resolveSettingsSection } from './settings-nav';

/** Sections laid out on the full content width (two columns, lists); the others read better narrow. */
const FULL_WIDTH = new Set(['workflow', 'time', 'api']);

/**
 * Settings: the section nav lives in the settings sidebar (`SettingsSidebar`, shown by the main sidebar
 * while a settings page is open); this page is the header row plus the section itself. On phones, where
 * the sidebar is a sheet, a strip of section chips sits above the content.
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
    PersonalIntegrationsSection,
    PreferencesSection,
    NotificationsSection,
    AppearanceSection,
    ShortcutsSection,
    WorkspaceSection,
    MembersSection,
    RolesSection,
    AgentsSection,
    AiSection,
    ApiSection,
    IntegrationsSection,
    LabelsSection,
    WorkflowSection,
    EstimatesSection,
    TimeSection,
    ImportSection,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header [title]="current()?.label ?? 'Settings'" />
    <nav
      class="border-border scrollbar-none flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 md:hidden"
      aria-label="Settings sections"
    >
      @for (g of groups; track g.title) {
        @for (s of g.sections; track s.id) {
          <a
            class="flex h-8 shrink-0 items-center gap-2 px-3 text-[13px] whitespace-nowrap"
            [class]="sectionId() === s.id ? 'bg-hover text-foreground' : 'text-muted-foreground'"
            [attr.aria-current]="sectionId() === s.id ? 'page' : null"
            [routerLink]="['/', slug(), 'settings', s.id]"
          >
            <svg [lucideIcon]="s.icon" [size]="14" class="shrink-0"></svg>
            {{ s.label }}
          </a>
        }
      }
    </nav>

    @if (sectionId() === 'integrations') {
      <!-- master / detail: owns the whole content area -->
      <app-integrations-section class="min-h-0 flex-1" />
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="w-full px-5 py-6 sm:px-10 sm:py-8 lg:px-14" [class]="fullWidth() ? 'max-w-[1240px]' : 'max-w-[920px]'">
          @switch (sectionId()) {
            @case ('ai') { <app-ai-section /> }
            @case ('profile') {
              <app-profile-section />
            }
            @case ('my-integrations') {
              <app-personal-integrations-section />
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
            @case ('agents') {
              <app-agents-section [agentId]="agent()" />
            }
            @case ('api') {
              <app-api-section [agentId]="agent()" />
            }
            @case ('labels') {
              <app-labels-section />
            }
            @case ('workflow') {
              <app-workflow-section />
            }
            @case ('estimates') {
              <app-estimates-section />
            }
            @case ('time') {
              <app-time-section />
            }
            @case ('import') {
              <app-import-section />
            }
            @default {
              <app-empty-state [icon]="warn" title="Unknown settings section" description="Pick a section from the settings menu." />
            }
          }
        </div>
      </div>
    }
  `,
})
export class SettingsPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly section = input<string>();
  /** `?agent=<id>`: opens that agent (Agents) or preselects it when creating a token (API & MCP). */
  readonly agent = input<string>();

  private readonly store = inject(TramaStore);

  protected readonly groups = SETTINGS_GROUPS;
  protected readonly warn = LucideTriangleAlert;
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly sectionId = computed(() => resolveSettingsSection(this.section()));
  protected readonly current = computed(() => SETTINGS_SECTIONS.find((s) => s.id === this.sectionId()));
  protected readonly fullWidth = computed(() => FULL_WIDTH.has(this.sectionId()));

  constructor() {
    // "Settings / Workflow": the parent crumb is plain text, the page is the last one.
    usePageCrumbs(() => [{ label: 'Settings' }, { label: this.current()?.label ?? 'Settings' }]);
  }
}
