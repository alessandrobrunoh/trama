import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { ESTIMATE_SCALES, LABEL_SWATCHES, WEEK_STARTS, type EstimateScale, type WeekStart, type CustomerTier } from '../../../core/contracts/domain';
import { ESTIMATE_SCALE_DEFS, ESTIMATE_SCALE_ORDER } from '../../../core/estimates';
import { Notifier } from '../../../core/notify/notifier';
import { SessionStore } from '../../../core/session/session.store';
import { NablaStore } from '../../../core/stores/nabla.store';
import { UiStore } from '../../../core/stores/ui.store';
import { FullDatePipe } from '../../../shared/pipes';
import { ProviderIcon } from '../../../shared/provider-icon';
import { AppSelect, type Option } from '../../create/form-kit';
import { SECTION_KIT } from './section-kit';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Workspace name + URL, a few facts, and the danger zone. */
@Component({
  selector: 'app-workspace-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, HlmSwitchImports, LucideDynamicIcon, FullDatePipe, ProviderIcon, AppSelect, ...SECTION_KIT],
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
              <span class="text-muted-foreground bg-muted/50 flex h-full items-center border-r px-2 font-mono text-xs">{{ host }}/</span>
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
                  class="size-5 rounded-full border-2 transition-transform hover:scale-110 disabled:opacity-50"
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
        <app-settings-row label="Default team" description="Preselected when someone files an issue or starts a workstream." wide>
          <app-select size="sm" [options]="teamOptions()" [value]="prefs().defaultTeamId" (valueChange)="patchPrefs({ defaultTeamId: $event })" [disabled]="!canAdmin()" label="Default team" />
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

    <app-settings-group title="Features" description="Optional parts of Trama. Turn off what your team does not use.">
      <app-settings-row label="Delta threads" description="Link each workstream to the Delta thread where the work happens, and show it on workstreams, the timeline and the graph. When off, the link is hidden. The link is always optional when creating a workstream. Existing links are kept.">
        <span class="flex items-center gap-3">
          <span class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
            <app-provider-icon provider="delta" [size]="11" /> Recommended
          </span>
          <hlm-switch [checked]="store.deltaThreads()" [disabled]="!canAdmin() || savingFeature()" (checkedChange)="setDeltaThreads($event)" aria-label="Delta threads" />
        </span>
      </app-settings-row>
      @if (!canAdmin()) {
        <div class="text-muted-foreground px-4 pb-3 text-xs">Only admins and owners can change features.</div>
      }
    </app-settings-group>

    <app-settings-group title="Estimates" description="How issues are sized. Estimates are stored as numbers, so switching scale never rewrites an issue: a value that is not on the new scale stays visible and selectable.">
      <div class="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2" role="radiogroup" aria-label="Estimate scale">
        @for (d of scaleDefs; track d.id) {
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="scale() === d.id"
            [disabled]="!canAdmin() || savingScale()"
            class="focus-visible:ring-ring/50 relative flex flex-col gap-2 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-3 disabled:cursor-not-allowed"
            [class]="scale() === d.id ? 'border-primary bg-accent/50' : 'border-border enabled:hover:border-border-strong enabled:hover:bg-hover'"
            (click)="setScale(d.id)"
          >
            <span class="flex items-center gap-2">
              <span class="text-[13px] font-medium">{{ d.label }}</span>
              @if (d.range) {
                <span class="text-muted-foreground text-xs">{{ d.range }}</span>
              }
              <span
                class="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full border"
                [class]="scale() === d.id ? 'bg-primary border-primary text-primary-foreground' : 'border-border-strong'"
                aria-hidden="true"
              >
                @if (scale() === d.id) {
                  <svg [lucideIcon]="checkIcon" [size]="10" [strokeWidth]="3"></svg>
                }
              </span>
            </span>
            <span class="flex min-h-5 flex-wrap items-center gap-1">
              @for (c of d.chips; track c.label) {
                <span class="bg-muted text-muted-foreground inline-flex min-w-5 items-center justify-center rounded px-1 text-[11px] leading-5 tabular-nums" [title]="c.title">{{ c.label }}</span>
              } @empty {
                <span class="text-muted-foreground text-[11px] italic">No estimate field</span>
              }
            </span>
            <span class="text-muted-foreground text-xs leading-snug">{{ d.description }}</span>
          </button>
        }
      </div>
      @if (!canAdmin()) {
        <div class="text-muted-foreground px-4 pb-3 text-xs">Only admins and owners can change the estimate scale.</div>
      }
    </app-settings-group>

    <app-settings-group title="Overview">
      <app-settings-row label="Created">
        <span class="text-muted-foreground text-[13px]">{{ store.workspace()?.createdAt | fullDate }}</span>
      </app-settings-row>
      <app-settings-row label="Contents" description="What this workspace holds right now.">
        <span class="text-muted-foreground text-[13px] tabular-nums">{{ counts() }}</span>
      </app-settings-row>
      <app-settings-row label="Labels" description="One catalog shared by issues, workstreams, projects and repositories.">
        <a hlmBtn variant="outline" size="sm" [routerLink]="['/', store.slug(), 'settings', 'labels']">Manage labels</a>
      </app-settings-row>
    </app-settings-group>

    <app-settings-group title="Customer tiers" description="Tiers you use to rank customers, for example Enterprise, Growth or Free. Assign one on each customer. Removing a tier leaves its customers without one.">
      @for (tier of tiers(); track tier.id) {
        <div class="flex items-center gap-2 border-t px-4 py-2 first:border-t-0">
          <span class="flex items-center gap-1" role="radiogroup" [attr.aria-label]="tier.name + ' color'">
            @for (swatch of swatchList; track swatch) {
              <button
                type="button"
                role="radio"
                class="size-4 rounded-full border-2 disabled:opacity-50"
                [style.background]="swatch"
                [class]="tier.color === swatch ? 'border-foreground' : 'border-transparent'"
                [attr.aria-checked]="tier.color === swatch"
                [attr.aria-label]="swatch"
                [disabled]="!canAdmin() || savingTier()"
                (click)="recolorTier(tier, swatch)"
              ></button>
            }
          </span>
          <input
            hlmInput
            class="h-8 min-w-0 flex-1 text-[13px]"
            maxlength="40"
            [value]="tier.name"
            [disabled]="!canAdmin() || savingTier()"
            [attr.aria-label]="'Rename ' + tier.name"
            (change)="renameTier(tier, $any($event.target).value)"
          />
          <button type="button" class="text-muted-foreground hover:text-destructive text-xs" [disabled]="!canAdmin() || savingTier()" (click)="removeTier(tier)">Remove</button>
        </div>
      } @empty {
        <div class="text-muted-foreground px-4 py-2 text-xs">No tiers yet.</div>
      }
      @if (canAdmin()) {
        <form class="flex items-center gap-2 border-t px-4 py-2" (submit)="addTier($event)">
          <input hlmInput class="h-8 min-w-0 flex-1 text-[13px]" maxlength="40" placeholder="New tier" aria-label="New customer tier" [value]="newTier()" [disabled]="savingTier()" (input)="newTier.set($any($event.target).value)" />
          <button hlmBtn type="submit" size="sm" [disabled]="!newTier().trim() || savingTier()">Add</button>
        </form>
      } @else {
        <div class="text-muted-foreground border-t px-4 py-2 text-xs">Only admins and owners can change customer tiers.</div>
      }
    </app-settings-group>

    <app-settings-group title="Danger zone">
      <app-settings-row
        label="Delete workspace"
        [description]="canOwner() ? 'Removes every workstream, issue, decision, repository and its history. This cannot be undone.' : 'Only an owner can delete the workspace.'"
      >
        <button hlmBtn variant="destructive" size="sm" [disabled]="!canOwner()" (click)="deleteWorkspace()">Delete workspace</button>
      </app-settings-row>
    </app-settings-group>
  `,
})
export class WorkspaceSection {
  private readonly session = inject(SessionStore);
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly host = typeof location !== 'undefined' ? location.host : 'nabla';
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
  protected readonly checkIcon = LucideCheck;
  protected readonly savingScale = signal(false);
  protected readonly savingFeature = signal(false);
  protected readonly savingTier = signal(false);
  protected readonly newTier = signal('');
  protected readonly tiers = computed(() => this.store.settings().customerTiers);
  protected readonly swatchList = LABEL_SWATCHES;
  protected readonly scale = computed(() => this.store.estimateScale());
  protected readonly scaleDefs = ESTIMATE_SCALE_ORDER.filter((s) => ESTIMATE_SCALES.includes(s)).map((id) => {
    const def = ESTIMATE_SCALE_DEFS[id];
    const first = def.options[0]?.label;
    const last = def.options[def.options.length - 1]?.label;
    return {
      id,
      label: def.label,
      description: def.description,
      range: def.options.length && id !== 'tshirt' ? `${first}–${last}` : '',
      chips: def.options.map((o) => ({ label: o.label, title: o.label === String(o.value) ? `${o.value} points` : `${o.label} = ${o.value} points` })),
    };
  });
  protected readonly weekOptions: Option[] = WEEK_STARTS.map((w) => ({ value: w, label: w[0].toUpperCase() + w.slice(1) }));
  protected readonly browserZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  protected readonly zones: string[] = (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl
    ? (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
    : []);
  protected readonly prefs = signal(this.storedPrefs());
  protected readonly teamOptions = computed<Option[]>(() => [
    { value: '', label: 'No default' },
    ...this.store.teams().map((t) => ({ value: t.id, label: t.name, hint: t.key })),
  ]);
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
    return [
      `${s.workstreams().length} workstreams`,
      `${s.issues().length} issues`,
      `${s.decisions().length} decisions`,
      `${s.memberships().length} members`,
    ].join(' · ');
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
      defaultTeamId: s.defaultTeamId ?? '',
      weekStart: s.weekStart as WeekStart,
      timeZone: s.timeZone,
    };
  }
  /** Saves immediately (a radio choice, not a form field). */
  protected async setScale(scale: EstimateScale): Promise<void> {
    if (!this.canAdmin() || scale === this.scale() || this.savingScale()) return;
    this.savingScale.set(true);
    const ok = await this.store.updateSettings({ estimateScale: scale });
    this.savingScale.set(false);
    if (ok) this.notify.success(`Estimates: ${ESTIMATE_SCALE_DEFS[scale].label}`, { description: scale === 'none' ? 'Estimates are hidden; existing values are kept.' : 'Existing estimates keep their value.' });
  }
  protected async setDeltaThreads(enabled: boolean): Promise<void> {
    if (!this.canAdmin() || enabled === this.store.deltaThreads() || this.savingFeature()) return;
    this.savingFeature.set(true);
    const ok = await this.store.updateSettings({ deltaThreads: enabled });
    this.savingFeature.set(false);
    if (ok) this.notify.success(enabled ? 'Delta threads turned on' : 'Delta threads turned off');
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
      defaultTeamId: p.defaultTeamId || null,
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

  protected async recolorTier(tier: CustomerTier, color: string): Promise<void> {
    if (!this.canAdmin() || tier.color === color || this.savingTier()) return;
    this.savingTier.set(true);
    const ok = await this.store.updateCustomerTier(tier.id, { color });
    this.savingTier.set(false);
    if (ok) this.notify.success('Tier updated');
  }

  protected async renameTier(tier: CustomerTier, value: string): Promise<void> {
    const name = value.trim();
    if (!this.canAdmin() || !name || name === tier.name || this.savingTier()) return;
    this.savingTier.set(true);
    const ok = await this.store.updateCustomerTier(tier.id, { name });
    this.savingTier.set(false);
    if (ok) this.notify.success('Tier updated');
  }

  protected async removeTier(tier: CustomerTier): Promise<void> {
    if (!this.canAdmin() || this.savingTier()) return;
    this.savingTier.set(true);
    const ok = await this.store.deleteCustomerTier(tier.id);
    this.savingTier.set(false);
    if (ok) this.notify.success('Tier removed');
  }

  protected async addTier(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.newTier().trim();
    if (!this.canAdmin() || !name || this.savingTier()) return;
    this.savingTier.set(true);
    const ok = await this.store.createCustomerTier({ name });
    this.savingTier.set(false);
    if (ok) {
      this.newTier.set('');
      this.notify.success('Tier added');
    }
  }

  protected deleteWorkspace(): void {
    const name = this.session.workspace()?.name ?? 'this workspace';
    this.ui.setConfirmDelete({
      title: `Delete ${name}?`,
      description: 'Every workstream, issue, repository and decision in it is removed. This cannot be undone.',
      confirmLabel: 'Delete workspace',
      onConfirm: async () => {
        await this.session.deleteWorkspace();
      },
    });
  }
}
