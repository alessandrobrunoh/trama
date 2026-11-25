import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { WEEK_STARTS, type WeekStart } from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { SessionStore } from '../../../core/session/session.store';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { FullDatePipe } from '../../../shared/pipes';
import { AppSelect, type Option } from '../../create/form-kit';
import { SECTION_KIT } from './section-kit';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Workspace name + URL, a few facts, and the danger zone. */
@Component({
  selector: 'app-workspace-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, FullDatePipe, AppSelect, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header title="Workspace" description="General settings for everyone in this workspace." />
      @if (!canAdmin()) {
        <app-readonly-note>Only admins and owners can change workspace settings.</app-readonly-note>
      }
      <form (submit)="save($event)">
        <app-settings-group title="General">
          <app-settings-row label="Name" description="Shown in the sidebar and in invitations." wide>
            <input hlmInput class="h-8 w-full text-[13px]" [value]="name()" [disabled]="!canAdmin()" (input)="name.set($any($event.target).value)" aria-label="Workspace name" />
          </app-settings-row>
          <app-settings-row label="URL" description="Changing it moves everyone to the new address. Old links stop working." wide>
            <div class="border-input focus-within:ring-ring/50 focus-within:border-ring flex h-8 items-center overflow-hidden rounded-md border focus-within:ring-3">
              <span class="text-muted-foreground bg-muted flex h-full items-center px-2 font-mono text-xs">{{ host }}/</span>
              <input
                class="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-xs outline-none disabled:opacity-50"
                [value]="slugValue()"
                [disabled]="!canAdmin()"
                (input)="slugValue.set($any($event.target).value.toLowerCase())"
                aria-label="Workspace URL"
              />
            </div>
            @if (slugError(); as e) {
              <p class="text-destructive mt-1 text-xs">{{ e }}</p>
            }
          </app-settings-row>
          @if (canAdmin()) {
            <div class="bg-muted/30 flex items-center justify-end gap-2 px-4 py-2">
              @if (dirty()) {
                <button hlmBtn type="button" variant="ghost" size="sm" (click)="resetForm()">Cancel</button>
              }
              <button hlmBtn type="submit" size="sm" [disabled]="!dirty() || !!slugError() || !name().trim() || busy()">Save changes</button>
            </div>
          }
        </app-settings-group>
      </form>
    </div>

    <form (submit)="savePrefs($event)">
      <app-settings-group title="Preferences" description="How this workspace looks and counts. Stored on the server, so everyone sees the same.">
        <app-settings-row label="Icon" description="Shown in the sidebar and workspace switcher. Its colour is also the accent colour of the whole workspace." >
          <div class="flex flex-wrap items-center justify-end gap-2">
            <span
              class="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
              [style.background]="prefs().iconColor || null"
              [style.color]="prefs().iconColor ? '#fff' : null"
              aria-hidden="true"
              >{{ prefs().iconInitial.trim() || (name().trim().slice(0, 1) || 'N').toUpperCase() }}</span
            >
            <input
              hlmInput
              class="h-8 w-14 text-center text-[13px] uppercase"
              maxlength="2"
              placeholder="{{ (name().trim().slice(0, 1) || 'N').toUpperCase() }}"
              [value]="prefs().iconInitial"
              [disabled]="!canAdmin()"
              (input)="patchPrefs({ iconInitial: $any($event.target).value })"
              aria-label="Icon letters"
            />
            <div class="flex items-center gap-1" role="radiogroup" aria-label="Icon colour">
              @for (c of swatches; track c) {
                <button
                  type="button"
                  role="radio"
                  class="size-5 border-2 transition-transform hover:scale-110 disabled:opacity-50"
                  [style.background]="c"
                  [class]="prefs().iconColor === c ? 'border-foreground' : 'border-transparent'"
                  [attr.aria-checked]="prefs().iconColor === c"
                  [attr.aria-label]="c"
                  [disabled]="!canAdmin()"
                  (click)="patchPrefs({ iconColor: c })"
                ></button>
              }
              <button type="button" class="text-muted-foreground hover:text-foreground ml-1 text-xs underline-offset-2 hover:underline" [disabled]="!canAdmin() || !prefs().iconColor" (click)="patchPrefs({ iconColor: '' })">Default</button>
            </div>
          </div>
        </app-settings-row>
        <app-settings-row label="Week starts on" description="Used by calendars, date pickers and cycles." wide>
          <app-select size="sm" [options]="weekOptions" [value]="prefs().weekStart" (valueChange)="patchPrefs({ weekStart: $any($event) })" [disabled]="!canAdmin()" label="Week starts on" />
        </app-settings-row>
        <app-settings-row label="Time zone" [description]="'Dates are shown in this zone. Auto follows each person’s browser (yours: ' + browserZone + ').'" wide>
          <input
            hlmInput
            class="h-8 w-full text-[13px]"
            list="workspace-time-zones"
            placeholder="auto"
            [value]="prefs().timeZone"
            [disabled]="!canAdmin()"
            (input)="patchPrefs({ timeZone: $any($event.target).value })"
            aria-label="Time zone"
          />
          <datalist id="workspace-time-zones">
            <option value="auto"></option>
            @for (z of zones; track z) {
              <option [value]="z"></option>
            }
          </datalist>
          @if (zoneError(); as e) {
            <p class="text-destructive mt-1 text-xs">{{ e }}</p>
          }
        </app-settings-row>
        @if (canAdmin()) {
          <div class="bg-muted/30 flex items-center justify-end gap-2 px-4 py-2">
            @if (prefsDirty()) {
              <button hlmBtn type="button" variant="ghost" size="sm" (click)="resetPrefs()">Cancel</button>
            }
            <button hlmBtn type="submit" size="sm" [disabled]="!prefsDirty() || !!zoneError() || busy()">Save preferences</button>
          </div>
        }
      </app-settings-group>
    </form>

    <app-settings-group title="Overview">
      <app-settings-row label="Created">
        <span class="text-muted-foreground text-[13px]">{{ store.workspace()?.createdAt | fullDate }}</span>
      </app-settings-row>
      <app-settings-row label="Contents" description="What this workspace holds right now.">
        <span class="text-muted-foreground text-[13px] tabular-nums">{{ counts() }}</span>
      </app-settings-row>
      <app-settings-row label="Labels" description="One catalog shared by tasks and projects.">
        <a hlmBtn variant="outline" size="sm" [routerLink]="['/', store.slug(), 'settings', 'labels']">Manage labels</a>
      </app-settings-row>
    </app-settings-group>

    <app-settings-group title="Danger zone">
      <app-settings-row
        label="Delete workspace"
        [description]="canOwner() ? 'Removes this workspace and all of its data. This cannot be undone.' : 'Only an owner can delete the workspace.'"
      >
        <button hlmBtn variant="destructive" size="sm" [disabled]="!canOwner()" (click)="deleteWorkspace()">Delete workspace</button>
      </app-settings-row>
    </app-settings-group>
  `,
})
export class WorkspaceSection {
  private readonly session = inject(SessionStore);
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly host = typeof location !== 'undefined' ? location.host : 'trama';
  protected readonly name = signal('');
  protected readonly slugValue = signal('');
  protected readonly busy = signal(false);
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly canOwner = computed(() => this.store.can('owner'));
  protected readonly dirty = computed(() => {
    const ws = this.session.workspace() ?? this.store.workspace();
    return !!ws && (this.name().trim() !== ws.name || this.slugValue().trim() !== ws.slug);
  });
  protected readonly slugError = computed(() => {
    const v = this.slugValue().trim();
    if (!v) return 'The URL cannot be empty.';
    return SLUG_RE.test(v) ? null : 'Use lowercase letters, numbers and dashes.';
  });
  // ───── preferences (server-side workspace settings)
  protected readonly swatches = ['#5e6ad2', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
  protected readonly weekOptions: Option[] = WEEK_STARTS.map((w) => ({ value: w, label: w[0].toUpperCase() + w.slice(1) }));
  protected readonly browserZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  protected readonly zones: string[] = (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl
    ? (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
    : []);
  protected readonly prefs = signal(this.storedPrefs());
  protected readonly zoneError = computed(() => {
    const z = this.prefs().timeZone.trim();
    if (!z || z === 'auto') return null;
    try {
      new Intl.DateTimeFormat('en', { timeZone: z });
      return null;
    } catch {
      return 'Unknown time zone. Use a name like Europe/Rome, or auto.';
    }
  });
  protected readonly prefsDirty = computed(() => JSON.stringify(this.prefs()) !== JSON.stringify(this.storedPrefs()));

  protected readonly counts = computed(() => {
    const s = this.store;
    return [`${s.issues().length} tasks`, `${s.projects().length} projects`, `${s.memberships().length} members`].join(' · ');
  });

  constructor() {
    effect(() => {
      const ws = this.session.workspace() ?? this.store.workspace();
      if (!ws) return;
      untracked(() => {
        this.name.set(ws.name);
        this.slugValue.set(ws.slug);
      });
    });
    // Follow server-side changes (another tab, a refetch) unless there are unsaved edits.
    effect(() => {
      const stored = this.storedPrefs();
      untracked(() => {
        if (!this.prefsDirty()) this.prefs.set(stored);
      });
    });
  }

  private storedPrefs() {
    const s = this.store.settings();
    return {
      iconColor: s.iconColor ?? '',
      iconInitial: s.iconInitial ?? '',
      weekStart: s.weekStart as WeekStart,
      timeZone: s.timeZone,
    };
  }
  protected patchPrefs(change: Partial<ReturnType<WorkspaceSection['storedPrefs']>>): void {
    this.prefs.update((p) => ({ ...p, ...change }));
  }
  protected resetPrefs(): void {
    this.prefs.set(this.storedPrefs());
  }
  protected async savePrefs(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.prefsDirty() || this.zoneError()) return;
    const p = this.prefs();
    this.busy.set(true);
    const ok = await this.store.updateSettings({
      iconColor: p.iconColor || null,
      iconInitial: p.iconInitial.trim() || null,
      weekStart: p.weekStart,
      timeZone: p.timeZone.trim() || 'auto',
    });
    this.busy.set(false);
    if (ok) this.notify.success('Preferences saved');
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
