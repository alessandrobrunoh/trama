import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRightLeft, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { WEEK_STARTS, type Project, type WeekStart } from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { SessionStore } from '../../../core/session/session.store';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { FullDatePipe } from '../../../shared/pipes';
import { AppSelect, type Option } from '../../create/form-kit';
import { ProjectTransferDialog } from '../../projects/project-transfer-dialog';
import { SECTION_KIT, SETTINGS_FIELD, type SegmentedOption, type StatCell } from './section-kit';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Accent swatches of the v4 General frame. Amber is the stylesheet default, so it is stored as "no colour";
 * the others are the colour the whole workspace takes as its accent (see `AccentService`).
 */
const ACCENTS: readonly { name: string; hex: string }[] = [
  { name: 'Terracotta', hex: '#B5583A' },
  { name: 'Vermilion', hex: '#CC4B30' },
  { name: 'Crimson', hex: '#E5484D' },
  { name: 'Orange', hex: '#EE6A2F' },
  { name: 'Amber', hex: '' },
  { name: 'Moss', hex: '#3F8F5A' },
  { name: 'Teal', hex: '#14918A' },
  { name: 'Cobalt', hex: '#3D5BD9' },
  { name: 'Violet', hex: '#7C5CC4' },
];

interface WorkspacePrefs {
  iconColor: string;
  iconInitial: string;
  weekStart: WeekStart;
  timeZone: string;
}

/** Workspace identity, look and calendar, a few facts, and the danger zone (v4 frame 01). */
@Component({
  selector: 'app-workspace-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmDropdownMenuImports,
    AppSelect,
    ProjectTransferDialog,
    ...SECTION_KIT,
  ],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Workspace"
      [description]="'Settings for everyone in ' + (store.slug() ?? 'this workspace') + '. Look and calendar save as you change them.'"
    />

    @if (!canAdmin()) {
      <app-readonly-note>Only admins and owners can change workspace settings.</app-readonly-note>
    }

    <app-settings-block title="Identity">
      <form (submit)="save($event)">
        <app-settings-card>
          <app-card-row label="Icon" description="Shown in the sidebar and the workspace switcher.">
            <span
              class="bg-primary text-primary-foreground font-title focus-within:ring-ring/50 relative flex size-10 shrink-0 items-center justify-center text-[22px] leading-[normal] focus-within:ring-2"
              [style.background]="prefs().iconColor || null"
              [style.color]="prefs().iconColor ? 'var(--primary-foreground)' : null"
            >
              <input
                class="font-title absolute inset-0 size-full cursor-text bg-transparent text-center text-[22px] leading-[normal] uppercase outline-none placeholder:text-current disabled:cursor-default"
                maxlength="2"
                [placeholder]="iconLetter()"
                [value]="prefs().iconInitial"
                [disabled]="!canAdmin()"
                (change)="patchPrefs({ iconInitial: $any($event.target).value.trim() })"
                aria-label="Icon letters"
              />
            </span>
          </app-card-row>
          <app-card-row label="Name" description="Shown in the sidebar and in invitations." wide>
            <input
              [class]="field"
              [value]="name()"
              [disabled]="!canAdmin()"
              (input)="name.set($any($event.target).value)"
              aria-label="Workspace name"
            />
          </app-card-row>
          <app-card-row label="URL" description="Changing it moves everyone to the new address. Old links stop working." wide>
            <div
              class="bg-background border-border focus-within:border-primary flex min-w-0 items-center gap-2 border px-2.5 py-[7px]"
            >
              <span class="text-faint shrink-0 font-mono text-[12px] leading-[18px]">{{ host }}/</span>
              <input
                class="text-foreground min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] outline-none disabled:opacity-50"
                [value]="slugValue()"
                [disabled]="!canAdmin()"
                (input)="slugValue.set($any($event.target).value.toLowerCase())"
                aria-label="Workspace URL"
              />
            </div>
            @if (slugError(); as e) {
              <p class="text-red mt-1 font-mono text-[10.5px]">{{ e }}</p>
            }
          </app-card-row>
          @if (canAdmin() && dirty()) {
            <div class="flex items-center justify-end gap-2 px-4 py-3">
              <button hlmBtn type="button" variant="ghost" size="sm" (click)="resetForm()">Cancel</button>
              <button hlmBtn type="submit" size="sm" [disabled]="!!slugError() || !name().trim() || busy()">Save changes</button>
            </div>
          }
        </app-settings-card>
      </form>
    </app-settings-block>

    <app-settings-block title="Look and calendar">
      <app-settings-card>
        <app-card-row
          label="Accent colour"
          description="Buttons, focus and progress for the whole workspace. The Trama logo stays amber."
        >
          <div class="flex items-center gap-1.5" role="radiogroup" aria-label="Accent colour">
            @for (c of accents; track c.name) {
              <button
                type="button"
                role="radio"
                class="size-5 shrink-0 transition-transform hover:scale-110 disabled:opacity-50 disabled:hover:scale-100"
                [style.background]="c.hex || '#E2A93B'"
                [class]="isAccent(c.hex) ? 'outline-foreground outline-2 -outline-offset-1' : ''"
                [attr.aria-checked]="isAccent(c.hex)"
                [attr.aria-label]="c.name"
                [attr.title]="c.name"
                [disabled]="!canAdmin()"
                (click)="patchPrefs({ iconColor: c.hex })"
              ></button>
            }
          </div>
        </app-card-row>
        <app-card-row label="Week starts on" description="Used by calendars, date pickers, cycles and the timesheet.">
          <app-segmented
            aria-label="Week starts on"
            [options]="weekOptions"
            [value]="prefs().weekStart"
            [disabled]="!canAdmin()"
            (valueChange)="patchPrefs({ weekStart: $any($event) })"
          />
        </app-card-row>
        <app-card-row label="Time zone" [description]="'Auto follows each person’s browser (yours: ' + browserZone + ').'" wide>
          <app-select
            label="Time zone"
            [options]="zoneOptions()"
            [value]="prefs().timeZone || 'auto'"
            [disabled]="!canAdmin()"
            (valueChange)="patchPrefs({ timeZone: $event })"
          />
        </app-card-row>
      </app-settings-card>
    </app-settings-block>

    <app-settings-block title="At a glance">
      <app-stat-strip [cells]="stats()" />
    </app-settings-block>

    <app-settings-block title="Danger zone">
      <app-settings-card tone="danger">
        <app-card-row
          label="Transfer ownership"
          [description]="canOwner() ? 'Hand the workspace to another member. You become an admin.' : 'Only an owner can hand the workspace over.'"
        >
          <a hlmBtn variant="outline" [class.pointer-events-none]="!canOwner()" [class.opacity-50]="!canOwner()" [routerLink]="['/', store.slug(), 'settings', 'members']">Transfer…</a>
        </app-card-row>
        <app-card-row
          label="Transfer a project"
          [description]="canAdmin() ? 'Move one project to another workspace you admin. Statuses and labels are mapped, task keys kept, guests carried over.' : 'Only admins and owners can move a project.'"
        >
          <button
            hlmBtn
            type="button"
            variant="outline"
            [disabled]="!canAdmin() || !projects().length"
            [hlmDropdownMenuTrigger]="projectMenu"
            aria-label="Choose the project to transfer"
          >
            <svg [lucideIcon]="transferIcon" [size]="13"></svg> Transfer project…
          </button>
        </app-card-row>
        <app-card-row
          danger
          label="Delete workspace"
          [description]="canOwner() ? 'Removes ' + (store.slug() ?? 'this workspace') + ' and all of its data. Type the workspace name to confirm.' : 'Only an owner can delete the workspace.'"
        >
          <button hlmBtn variant="destructive" [disabled]="!canOwner()" (click)="deleteWorkspace()">Delete workspace</button>
        </app-card-row>
      </app-settings-card>
    </app-settings-block>

    <ng-template #projectMenu>
      <hlm-dropdown-menu class="max-h-72 w-60 overflow-y-auto">
        @for (p of projects(); track p.id) {
          <button hlmDropdownMenuItem (triggered)="startTransfer(p)">{{ p.name }}</button>
        }
      </hlm-dropdown-menu>
    </ng-template>

    @if (transferring(); as p) {
      <app-project-transfer-dialog [project]="p" [open]="true" (openChange)="$event || transferring.set(null)" />
    }
  `,
})
export class WorkspaceSection {
  private readonly session = inject(SessionStore);
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly field = SETTINGS_FIELD;
  protected readonly host = typeof location !== 'undefined' ? location.host : 'trama';
  protected readonly name = signal('');
  protected readonly slugValue = signal('');
  protected readonly busy = signal(false);
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly canOwner = computed(() => this.store.can('owner'));
  protected readonly transferIcon = LucideArrowRightLeft;
  protected readonly projects = computed(() => this.store.projects());
  protected readonly transferring = signal<Project | null>(null);
  protected readonly dirty = computed(() => {
    const ws = this.session.workspace() ?? this.store.workspace();
    return !!ws && (this.name().trim() !== ws.name || this.slugValue().trim() !== ws.slug);
  });
  protected readonly slugError = computed(() => {
    const v = this.slugValue().trim();
    if (!v) return 'The URL cannot be empty.';
    return SLUG_RE.test(v) ? null : 'Use lowercase letters, numbers and dashes.';
  });

  // ───── look and calendar (server-side workspace settings, saved as they change)
  protected readonly accents = ACCENTS;
  protected readonly weekOptions: SegmentedOption[] = WEEK_STARTS.filter((w) => w !== 'saturday').map((w) => ({ value: w, label: w[0].toUpperCase() + w.slice(1) }));
  protected readonly browserZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  private readonly zones: string[] =
    typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl
      ? (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
      : [];
  protected readonly prefs = computed<WorkspacePrefs>(() => {
    const s = this.store.settings();
    return {
      iconColor: s.iconColor ?? '',
      iconInitial: s.iconInitial ?? '',
      weekStart: s.weekStart as WeekStart,
      timeZone: s.timeZone,
    };
  });
  protected readonly iconLetter = computed(() => {
    const own = this.prefs().iconInitial.trim();
    return (own || this.name().trim().slice(0, 1) || 'N').toUpperCase();
  });
  protected readonly zoneOptions = computed<Option[]>(() => {
    const current = this.prefs().timeZone;
    const known = new Set(this.zones);
    const list = [...this.zones];
    if (current && current !== 'auto' && !known.has(current)) list.unshift(current);
    return [{ value: 'auto', label: `Auto · ${this.browserZone}` }, ...list.map((z) => ({ value: z, label: z }))];
  });

  protected readonly stats = computed<StatCell[]>(() => {
    const s = this.store;
    const agents = s.agents().length;
    const members = s.memberships().length;
    return [
      { label: 'Created', value: this.fullDate.transform(s.workspace()?.createdAt) || '—' },
      { label: 'Tasks', value: String(s.issues().length) },
      { label: 'Projects', value: String(s.projects().length) },
      { label: 'Members', value: agents ? `${members} · ${agents} agents` : String(members) },
    ];
  });
  private readonly fullDate = new FullDatePipe();

  constructor() {
    effect(() => {
      const ws = this.session.workspace() ?? this.store.workspace();
      if (!ws) return;
      untracked(() => {
        this.name.set(ws.name);
        this.slugValue.set(ws.slug);
      });
    });
  }

  protected isAccent(hex: string): boolean {
    return (this.prefs().iconColor || '').toLowerCase() === hex.toLowerCase();
  }

  /** Saves one setting at once (a pick, not a form field). */
  protected async patchPrefs(change: Partial<WorkspacePrefs>): Promise<void> {
    if (!this.canAdmin() || this.busy()) return;
    const next = { ...this.prefs(), ...change };
    this.busy.set(true);
    await this.store.updateSettings({
      iconColor: next.iconColor || null,
      iconInitial: next.iconInitial.trim() || null,
      weekStart: next.weekStart,
      timeZone: next.timeZone.trim() || 'auto',
    });
    this.busy.set(false);
  }

  protected startTransfer(project: Project): void {
    this.transferring.set(project);
  }

  protected resetForm(): void {
    const ws = this.session.workspace() ?? this.store.workspace();
    if (!ws) return;
    this.name.set(ws.name);
    this.slugValue.set(ws.slug);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.dirty() || this.slugError()) return;
    this.busy.set(true);
    const ok = await this.session.updateWorkspace({ name: this.name().trim(), slug: this.slugValue().trim() });
    this.busy.set(false);
    if (ok) this.notify.success('Workspace updated');
  }

  protected deleteWorkspace(): void {
    const ws = this.session.workspace();
    if (!ws) return;
    this.ui.setConfirmDelete({
      title: `Delete ${ws.name}?`,
      description:
        'The workspace and all of its data are removed for everyone. This cannot be undone.',
      confirmLabel: 'Delete workspace',
      requireText: { accept: [ws.name, ws.slug], label: `Type ${ws.name} to confirm` },
      onConfirm: async (typed) => {
        await this.session.deleteWorkspace(typed);
      },
    });
  }
}
