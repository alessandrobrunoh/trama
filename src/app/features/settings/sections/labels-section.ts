import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  LucideArchive,
  LucideArchiveRestore,
  LucideCheck,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideGitMerge,
  LucidePencil,
  LucidePlus,
  LucideSearch,
  LucideTrash2,
  LucideTriangleAlert,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  LABEL_NAME_MAX,
  LABEL_SWATCHES,
  type LabelScope,
  type StoredLabelScope,
  type WorkspaceLabel,
} from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { EmptyState } from '../../../shared/empty-state';
import { LabelCatalog, describeUsage, type LabelUsage } from '../../../shared/label-catalog';
import { LabelChip } from '../../../shared/label-chip';
import { Picker, type PickOption } from '../../../shared/picker';
import { V3_FIELD, V3DialogFoot, V3DialogHead } from '../../../shared/v3';
import { SECTION_KIT, type SegmentedOption } from './section-kit';

type Dialog =
  | { kind: 'form'; label: WorkspaceLabel | null }
  | { kind: 'merge'; label: WorkspaceLabel }
  | { kind: 'delete'; label: WorkspaceLabel };

type Sort = 'name' | 'usage';
type ScopeFilter = 'all' | LabelScope;
type ActiveLabelScope = LabelScope;

const SCOPE_NOUN: Record<ActiveLabelScope, string> = {
  issue: 'Task',
  project: 'Project',
};

const HEX = /^#[0-9a-f]{6}$/i;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a delete or merge touches, in words: "12 issues, 3 projects". */
const impactText = (u: LabelUsage): string => describeUsage(u, 'nothing yet').replaceAll(' · ', ', ');

/**
 * The workspace label catalog: one place to see every label with how much it is used, and to rename,
 * recolor, merge, archive or delete it with a preview of what changes.
 */
@Component({
  selector: 'app-labels-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    HlmButtonImports,
    HlmDialogImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    LabelChip,
    EmptyState,
    Picker,
    V3DialogHead,
    V3DialogFoot,
    ...SECTION_KIT,
  ],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header flush title="Labels" description="Tag tasks across projects. Each label applies to tasks or projects. Templates are task labels; their name and scope stay fixed.">
      <div actions>
        @if (catalog.canCreate()) {
          <button hlmBtn (click)="openForm(null)">
            <svg [lucideIcon]="plus" [size]="13"></svg>
            New label
          </button>
        }
      </div>
    </app-section-header>

    @if (!catalog.canManage()) {
      <app-readonly-note class="mb-0!">Only admins can rename, recolor, merge, archive or delete labels. You can still add a label from any label picker.</app-readonly-note>
    }

    <div class="flex flex-wrap items-center gap-2">
      <div
        class="bg-background border-border focus-within:border-primary flex w-full min-w-0 items-center gap-2 border px-2.5 py-[7px] sm:w-[260px]"
      >
        <svg [lucideIcon]="searchIcon" [size]="13" class="text-faint shrink-0"></svg>
        <input
          type="search"
          class="text-foreground placeholder:text-faint min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] outline-none"
          placeholder="Filter labels"
          aria-label="Filter labels"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </div>
      <app-segmented aria-label="Which records" [options]="scopeFilterOptions" [value]="scopeFilter()" (valueChange)="scopeFilter.set($any($event))" />
      <span class="flex-1"></span>
      <span class="text-faint font-mono text-[10.5px]">{{ matching().length }} {{ matching().length === 1 ? 'label' : 'labels' }}</span>
      <app-segmented aria-label="Sort labels" [options]="sortOptions" [value]="sort()" (valueChange)="sort.set($any($event))" />
    </div>

    @if (active().length) {
      <div class="bg-card border-border border">
        <ng-container *ngTemplateOutlet="head" />
        @for (l of active(); track l.id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: l }" />
        }
      </div>
    } @else {
      <app-empty-state [icon]="searchIcon" title="No label matches" [description]="query() ? 'Nothing is called “' + query() + '”.' : 'Create the first label.'" />
    }

    @if (archived().length) {
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <svg [lucideIcon]="archive" [size]="13" class="text-muted-foreground shrink-0"></svg>
          <span class="text-foreground text-[13px] font-medium">Archived</span>
          <span class="text-faint font-mono text-[10.5px]">{{ archived().length }} · hidden from pickers, restorable</span>
        </div>
        <div class="bg-card border-border border">
          <ng-container *ngTemplateOutlet="head" />
          @for (l of archived(); track l.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: l }" />
          }
        </div>
      </div>
    }

    <ng-template #head>
      <div class="bg-bg-deep text-faint flex items-center gap-4 px-4 py-2 font-mono text-[10.5px] leading-normal">
        <span class="min-w-0 flex-1 sm:w-[220px] sm:flex-none">LABEL</span>
        <span class="hidden min-w-0 flex-1 md:block">USED BY</span>
        <span class="hidden w-[120px] shrink-0 sm:block">SCOPE</span>
        <span class="w-[60px] shrink-0">USED</span>
        <span class="w-[14px] shrink-0"></span>
      </div>
    </ng-template>

    <ng-template #row let-l>
      <div class="border-border hover:bg-hover/40 flex items-center gap-4 border-t px-4 py-[9px]">
        <div class="flex min-w-0 flex-1 items-center gap-2 sm:w-[220px] sm:flex-none">
          <span class="size-[9px] shrink-0" [style.background]="l.color" aria-hidden="true"></span>
          @if (catalog.canManage()) {
            <button
              type="button"
              class="text-foreground focus-visible:ring-ring min-w-0 truncate text-left text-[13px] outline-none focus-visible:ring-2"
              [attr.aria-label]="'Edit label ' + l.name"
              (click)="openForm(l)"
            >
              {{ l.name }}
            </button>
          } @else {
            <span class="text-foreground min-w-0 truncate text-[13px]">{{ l.name }}</span>
          }
          @if (l.template) {
            <span class="border-border text-faint border px-1.5 font-mono text-[10px] leading-[14px]">Template</span>
          }
        </div>
        <span class="text-muted-foreground hidden min-w-0 flex-1 truncate text-[12.5px] md:block" [attr.title]="usageText(l.id)">{{ usageText(l.id) }}</span>
        <span class="text-muted-foreground hidden w-[120px] shrink-0 font-mono text-[10.5px] sm:block">{{ scopeNoun(l.scope) }}</span>
        <span class="text-text-2 w-[60px] shrink-0 font-mono text-[10.5px] tabular-nums">{{ catalog.usageOf(l.id).total }}</span>
        @if (catalog.canManage()) {
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground -my-1 -mr-1.5 size-6 shrink-0" [hlmDropdownMenuTrigger]="menu" [attr.aria-label]="'Actions for ' + l.name">
            <svg [lucideIcon]="more" [size]="14"></svg>
          </button>
          <ng-template #menu>
            <hlm-dropdown-menu class="w-48">
              <button hlmDropdownMenuItem (triggered)="openForm(l)">
                <svg [lucideIcon]="pencil" [size]="14"></svg>
                {{ l.template ? 'Change color' : 'Edit' }}
              </button>
              @if (!l.template) {
                <button hlmDropdownMenuItem (triggered)="openMerge(l)">
                  <svg [lucideIcon]="mergeIcon" [size]="14"></svg>
                  Merge into…
                </button>
                <button hlmDropdownMenuItem (triggered)="toggleArchive(l)">
                  <svg [lucideIcon]="l.archived ? restore : archive" [size]="14"></svg>
                  {{ l.archived ? 'Restore' : 'Archive' }}
                </button>
                <button hlmDropdownMenuItem variant="destructive" (triggered)="openDelete(l)">
                  <svg [lucideIcon]="trash" [size]="14"></svg>
                  Delete
                </button>
              }
            </hlm-dropdown-menu>
          </ng-template>
        } @else {
          <span class="w-[14px] shrink-0"></span>
        }
      </div>
    </ng-template>

    <hlm-dialog [state]="dlg() ? 'open' : 'closed'" (closed)="closeDialog()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[90svh] gap-0 overflow-y-auto p-0 sm:max-w-md" [showCloseButton]="false">
        @switch (dlg()?.kind) {
          @case ('form') {
            <form class="contents" (submit)="submitForm($event)">
              <v3-dialog-head kicker="LABEL" (dismiss)="closeDialog()">
                <h2 hlmDialogTitle>{{ editing() ? 'Edit label' : 'New label' }}</h2>
              </v3-dialog-head>
              <p hlmDialogDescription class="text-muted-foreground px-[18px] pt-3.5 text-[12.5px] leading-snug">
                {{ editing()?.template ? 'Templates stay task labels; you can change the color.' : 'A short name, and which records it can be added to.' }}
              </p>
              <div class="flex flex-col gap-4 p-[18px] text-[13px]">
                <div class="flex flex-col gap-1.5">
                  <label class="text-faint font-mono text-[10.5px] leading-[14px]" for="label-name">NAME</label>
                  <input
                    id="label-name"
                    [class]="fieldClass"
                    autocomplete="off"
                    [attr.maxlength]="nameMax"
                    [value]="formName()"
                    [disabled]="!!editing()?.template || busy()"
                    [attr.aria-invalid]="nameError() ? 'true' : null"
                    [attr.aria-describedby]="nameError() ? 'label-name-error' : null"
                    (input)="formName.set($any($event.target).value)"
                  />
                  @if (nameError(); as e) {
                    <span id="label-name-error" class="text-red font-mono text-[10.5px]">{{ e }}</span>
                  }
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class="text-faint font-mono text-[10.5px] leading-[14px]">APPLIES TO</span>
                  <app-segmented
                    aria-label="Applies to"
                    [options]="scopeOptions"
                    [value]="formScope()"
                    [disabled]="!!editing()?.template || busy()"
                    (valueChange)="formScope.set($any($event))"
                  />
                </div>
                <div class="flex flex-col gap-2">
                  <span class="text-faint font-mono text-[10.5px] leading-[14px]" id="label-color-label">COLOR</span>
                  <div class="grid w-fit grid-cols-6 gap-2" role="radiogroup" aria-labelledby="label-color-label">
                    @for (c of swatches; track c) {
                      <button
                        type="button"
                        role="radio"
                        class="focus-visible:ring-ring flex size-7 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                        [style.background]="c"
                        [attr.aria-checked]="formColor().toLowerCase() === c"
                        [attr.aria-label]="c"
                        (click)="formColor.set(c)"
                      >
                        @if (formColor().toLowerCase() === c) {
                          <svg [lucideIcon]="checkIcon" [size]="14" [strokeWidth]="3" class="text-white"></svg>
                        }
                      </button>
                    }
                  </div>
                  <div class="flex items-center gap-2">
                    <input
                      type="color"
                      class="border-border h-[34px] w-10 shrink-0 cursor-pointer border bg-transparent p-0.5"
                      aria-label="Pick any color"
                      [value]="colorValid() ? formColor() : '#64748b'"
                      (input)="formColor.set($any($event.target).value)"
                    />
                    <input
                      [class]="fieldClass + ' w-28! font-mono'"
                      aria-label="Hex color"
                      maxlength="7"
                      [value]="formColor()"
                      [attr.aria-invalid]="colorValid() ? null : 'true'"
                      (input)="formColor.set($any($event.target).value)"
                    />
                  </div>
                </div>
                <div class="border-border flex items-center gap-2 border px-3 py-2">
                  <span class="text-faint font-mono text-[10.5px]">PREVIEW</span>
                  <app-label-chip [name]="formName().trim() || 'Label name'" [color]="colorValid() ? formColor() : '#64748b'" size="md" />
                </div>
              </div>
              <v3-dialog-foot>
                <button hlmBtn type="button" variant="outline" hlmDialogClose>Cancel</button>
                <button hlmBtn type="submit" [disabled]="!canSubmit() || busy()">{{ editing() ? 'Save' : 'Create label' }}</button>
              </v3-dialog-foot>
            </form>
          }
          @case ('merge') {
            @if (target(); as l) {
              <v3-dialog-head kicker="MERGE" (dismiss)="closeDialog()">
                <h2 hlmDialogTitle>Merge “{{ l.name }}”</h2>
              </v3-dialog-head>
              <p hlmDialogDescription class="text-muted-foreground px-[18px] pt-3.5 text-[12.5px] leading-snug">Everything labelled “{{ l.name }}” gets the label you choose instead, and “{{ l.name }}” is removed.</p>
              <div class="flex flex-col gap-3 p-[18px] text-[13px]">
                <div class="flex flex-col gap-1.5">
                  <span class="text-faint font-mono text-[10.5px] leading-[14px]">MERGE INTO</span>
                  <app-picker
                    variant="input"
                    label="Target label"
                    placeholder="Choose a label"
                    [options]="mergeOptions()"
                    [value]="mergeInto() ? [mergeInto()] : []"
                    (valueChange)="mergeInto.set($event[0] ?? '')"
                  />
                </div>
                <div class="border-border border px-3 py-2 text-[12px] leading-relaxed">
                  @if (mergeTarget(); as t) {
                    <p>
                      {{ impact(l.id) }} will be relabeled “{{ t.name }}”. Items that already have both keep one.
                    </p>
                  } @else {
                    <p class="text-muted-foreground">Choose the label that takes over.</p>
                  }
                  @if (viewsText(l.id); as v) {
                    <p class="text-muted-foreground mt-1">{{ v }}</p>
                  }
                </div>
                <p class="text-faint font-mono text-[10.5px]">This cannot be undone.</p>
              </div>
              <v3-dialog-foot>
                <button hlmBtn type="button" variant="outline" hlmDialogClose>Cancel</button>
                <button hlmBtn type="button" [disabled]="!mergeTarget() || busy()" (click)="confirmMerge()">Merge</button>
              </v3-dialog-foot>
            }
          }
          @case ('delete') {
            @if (target(); as l) {
              <v3-dialog-head kicker="DELETE" (dismiss)="closeDialog()">
                <h2 hlmDialogTitle>Delete “{{ l.name }}”?</h2>
              </v3-dialog-head>
              <p hlmDialogDescription class="text-muted-foreground px-[18px] pt-3.5 text-[12.5px] leading-snug">The label is removed from the workspace and from everything that carries it.</p>
              <div class="flex flex-col gap-3 p-[18px] text-[13px]">
                <div class="border-border border px-3 py-2 text-[12px] leading-relaxed">
                  <div class="flex items-center gap-2"><app-label-chip [labelId]="l.id" /></div>
                  @if (catalog.usageOf(l.id).total) {
                    <p class="mt-2 flex items-start gap-1.5">
                      <svg [lucideIcon]="warn" [size]="13" class="text-status-needs-input mt-px shrink-0"></svg>
                      <span>It will be removed from {{ impact(l.id) }}.</span>
                    </p>
                  } @else {
                    <p class="text-muted-foreground mt-2">Nothing carries this label.</p>
                  }
                  @if (viewsText(l.id); as v) {
                    <p class="text-muted-foreground mt-1">{{ v }}</p>
                  }
                </div>
                <p class="text-faint font-mono text-[10.5px]">Deleting cannot be undone. Archive it instead to keep it where it is and stop offering it.</p>
              </div>
              <v3-dialog-foot>
                <button hlmBtn type="button" variant="outline" hlmDialogClose>Cancel</button>
                @if (!l.archived) {
                  <button hlmBtn type="button" variant="outline" [disabled]="busy()" (click)="archiveFromDelete(l)">Archive instead</button>
                }
                <button hlmBtn type="button" variant="destructive" [disabled]="busy()" (click)="confirmDelete()">Delete label</button>
              </v3-dialog-foot>
            }
          }
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class LabelsSection {
  protected readonly store = inject(TramaStore);
  protected readonly catalog = inject(LabelCatalog);
  private readonly notify = inject(Notifier);

  protected readonly query = signal('');
  protected readonly sort = signal<Sort>('name');
  protected readonly sorts: { id: Sort; label: string }[] = [
    { id: 'name', label: 'Name' },
    { id: 'usage', label: 'Most used' },
  ];
  protected readonly scopeFilter = signal<'all' | ActiveLabelScope>('all');
  protected readonly scopeFilters: { id: 'all' | ActiveLabelScope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'issue', label: 'Tasks' },
    { id: 'project', label: 'Projects' },
  ];
  protected readonly scopes: { id: ActiveLabelScope; label: string }[] = [
    { id: 'issue', label: 'Tasks' },
    { id: 'project', label: 'Projects' },
  ];
  protected readonly sortOptions: SegmentedOption[] = this.sorts.map((s) => ({ value: s.id, label: s.label }));
  protected readonly scopeFilterOptions: SegmentedOption[] = this.scopeFilters.map((s) => ({ value: s.id, label: s.label }));
  protected readonly scopeOptions: SegmentedOption[] = this.scopes.map((s) => ({ value: s.id, label: s.label }));

  protected readonly dlg = signal<Dialog | null>(null);
  protected readonly busy = signal(false);
  protected readonly formName = signal('');
  protected readonly formColor = signal<string>(LABEL_SWATCHES[0]);
  protected readonly formScope = signal<StoredLabelScope>('issue');
  protected readonly mergeInto = signal('');

  protected readonly fieldClass = V3_FIELD;
  protected readonly swatches = LABEL_SWATCHES;
  protected readonly nameMax = LABEL_NAME_MAX;
  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly mergeIcon = LucideGitMerge;
  protected readonly archive = LucideArchive;
  protected readonly restore = LucideArchiveRestore;
  protected readonly trash = LucideTrash2;
  protected readonly checkIcon = LucideCheck;
  protected readonly warn = LucideTriangleAlert;

  protected readonly matching = computed(() => {
    const q = this.query().trim().toLowerCase();
    const scope = this.scopeFilter();
    const list = this.catalog.all().filter((label) => (scope === 'all' || label.scope === scope) && (!q || label.name.toLowerCase().includes(q)));
    const byName = (a: WorkspaceLabel, b: WorkspaceLabel) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (this.sort() === 'usage') return [...list].sort((a, b) => this.catalog.usageOf(b.id).total - this.catalog.usageOf(a.id).total || byName(a, b));
    return [...list].sort(byName);
  });
  protected readonly active = computed(() => this.matching().filter((label) => !label.archived));
  protected readonly archived = computed(() => this.matching().filter((label) => label.archived));

  /** The label being edited, or null when creating. */
  protected readonly editing = computed(() => {
    const d = this.dlg();
    return d?.kind === 'form' ? d.label : null;
  });
  /** The label a merge or delete dialog is about. */
  protected readonly target = computed(() => {
    const d = this.dlg();
    return d && d.kind !== 'form' ? d.label : null;
  });
  protected readonly mergeOptions = computed<PickOption[]>(() => {
    const scope = this.target()?.scope;
    return this.catalog
      .active()
      .filter((label) => label.id !== this.target()?.id && label.scope === scope)
      .map((label) => ({ value: label.id, label: label.name, kind: 'label' as const, color: label.color, hint: String(this.catalog.usageOf(label.id).total) }));
  });
  protected readonly mergeTarget = computed(() => this.catalog.get(this.mergeInto()) ?? null);

  protected readonly colorValid = computed(() => HEX.test(this.formColor()));
  protected readonly nameError = computed(() => {
    const name = this.formName().trim();
    if (!name) return this.formName() ? 'The name cannot be empty.' : null;
    if (name.length > LABEL_NAME_MAX) return `At most ${LABEL_NAME_MAX} characters.`;
    const clash = this.catalog.find(name);
    return clash && clash.id !== this.editing()?.id ? `“${clash.name}” already exists${clash.archived ? ' (archived)' : ''}.` : null;
  });
  protected readonly canSubmit = computed(() => {
    const name = this.formName().trim();
    if (!name || this.nameError() || !this.colorValid()) return false;
    const cur = this.editing();
    const scopeChanged = !!cur && !cur.template && this.formScope() !== cur.scope;
    return !cur || name !== cur.name || this.formColor().toLowerCase() !== cur.color || scopeChanged;
  });

  protected scopeNoun(scope: StoredLabelScope): string {
    return scope === 'workstream' ? 'Legacy' : SCOPE_NOUN[scope];
  }

  protected usageText(id: string): string {
    return describeUsage(this.catalog.usageOf(id));
  }

  protected impact(id: string): string {
    return impactText(this.catalog.usageOf(id));
  }

  /** "2 saved views filter on it (Open bugs, Q4)": they follow a merge and lose the filter on a delete. */
  protected viewsText(id: string): string {
    const names = this.catalog.viewsByLabel().get(id);
    if (!names?.length) return '';
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3}` : '');
    return `${plural(names.length, 'saved view filters', 'saved views filter')} on it (${shown}); the filter is updated.`;
  }

  protected openForm(label: WorkspaceLabel | null): void {
    this.formName.set(label?.name ?? '');
    this.formColor.set(label?.color ?? this.catalog.nextColor());
    this.formScope.set(label?.scope ?? 'issue');
    this.dlg.set({ kind: 'form', label });
  }

  protected openMerge(label: WorkspaceLabel): void {
    this.mergeInto.set('');
    this.dlg.set({ kind: 'merge', label });
  }

  protected openDelete(label: WorkspaceLabel): void {
    this.dlg.set({ kind: 'delete', label });
  }

  protected closeDialog(): void {
    this.dlg.set(null);
  }

  protected async submitForm(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit() || this.busy()) return;
    const cur = this.editing();
    const name = this.formName().trim();
    const color = this.formColor().toLowerCase();
    const scope = this.formScope();
    this.busy.set(true);
    let ok: boolean;
    if (cur) {
      ok = await this.store.updateLabel(cur.id, {
        ...(name !== cur.name ? { name } : {}),
        ...(color !== cur.color ? { color } : {}),
        ...(!cur.template && scope !== cur.scope && scope !== 'workstream' ? { scope } : {}),
      });
    } else {
      ok = scope !== 'workstream' && !!(await this.catalog.create(name, color, scope));
    }
    this.busy.set(false);
    if (!ok) return;
    this.closeDialog();
    this.notify.success(cur ? 'Label updated' : 'Label created');
  }

  protected async toggleArchive(label: WorkspaceLabel): Promise<void> {
    const ok = await this.store.updateLabel(label.id, { archived: !label.archived });
    if (ok) this.notify.success(label.archived ? `“${label.name}” restored` : `“${label.name}” archived`);
  }

  protected async archiveFromDelete(label: WorkspaceLabel): Promise<void> {
    this.busy.set(true);
    await this.toggleArchive(label);
    this.busy.set(false);
    this.closeDialog();
  }

  protected async confirmMerge(): Promise<void> {
    const from = this.target();
    const into = this.mergeTarget();
    if (!from || !into || this.busy()) return;
    this.busy.set(true);
    const ok = await this.store.mergeLabel(from.id, into.id);
    this.busy.set(false);
    if (!ok) return;
    this.closeDialog();
    this.notify.success(`“${from.name}” merged into “${into.name}”`);
  }

  protected async confirmDelete(): Promise<void> {
    const label = this.target();
    if (!label || this.busy()) return;
    this.busy.set(true);
    const ok = await this.store.deleteLabel(label.id);
    this.busy.set(false);
    if (!ok) return;
    this.closeDialog();
    this.notify.success(`“${label.name}” deleted`);
  }
}
