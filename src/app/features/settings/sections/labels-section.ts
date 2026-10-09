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
import { HlmInputImports } from '@spartan-ng/helm/input';
import { LABEL_NAME_MAX, LABEL_SWATCHES, type WorkspaceLabel } from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { EmptyState } from '../../../shared/empty-state';
import { LabelCatalog, describeUsage, type LabelUsage } from '../../../shared/label-catalog';
import { LabelChip } from '../../../shared/label-chip';
import { Picker, type PickOption } from '../../workstreams/picker';
import { SECTION_KIT } from './section-kit';

type Dialog =
  | { kind: 'form'; label: WorkspaceLabel | null }
  | { kind: 'merge'; label: WorkspaceLabel }
  | { kind: 'delete'; label: WorkspaceLabel };

type Sort = 'name' | 'usage';

const HEX = /^#[0-9a-f]{6}$/i;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a delete or merge touches, in words: "12 issues, 3 workstreams". */
const impactText = (u: LabelUsage): string => describeUsage(u, 'nothing yet').replaceAll(' · ', ', ');

/**
 * The workspace label catalog: one place to see every label with how much it is used, and to rename,
 * recolor, merge, archive or delete it with a preview of what changes.
 */
@Component({
  selector: 'app-labels-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, HlmButtonImports, HlmDialogImports, HlmDropdownMenuImports, HlmInputImports, LucideDynamicIcon, LabelChip, EmptyState, Picker, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <app-section-header title="Labels" description="One catalog for the whole workspace. Tag issues, workstreams, projects and repositories with the same labels, and find them again by filtering.">
      <div actions>
        @if (catalog.canCreate()) {
          <button hlmBtn size="sm" (click)="openForm(null)">
            <svg [lucideIcon]="plus" [size]="14"></svg>
            New label
          </button>
        }
      </div>
    </app-section-header>

    @if (!catalog.canManage()) {
      <app-readonly-note>Only admins can rename, recolor, merge, archive or delete labels. You can still add a label from any label picker.</app-readonly-note>
    }

    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-0 flex-1 basis-56">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input
          hlmInput
          type="search"
          class="h-8 w-full pl-8 text-[13px]"
          placeholder="Filter labels…"
          aria-label="Filter labels"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </div>
      <div class="bg-muted/50 inline-flex rounded-md border p-0.5" role="group" aria-label="Sort labels">
        @for (s of sorts; track s.id) {
          <button
            type="button"
            class="h-6 rounded-[5px] px-2.5 text-xs transition-colors"
            [class]="sort() === s.id ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'"
            [attr.aria-pressed]="sort() === s.id"
            (click)="sort.set(s.id)"
          >
            {{ s.label }}
          </button>
        }
      </div>
    </div>

    @if (active().length) {
      <app-settings-group [title]="'Labels · ' + active().length">
        @for (l of active(); track l.id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: l }" />
        }
      </app-settings-group>
    } @else {
      <app-empty-state [icon]="searchIcon" title="No label matches" [description]="query() ? 'Nothing is called “' + query() + '”.' : 'Create the first label.'" />
    }

    @if (archived().length) {
      <app-settings-group [title]="'Archived · ' + archived().length" description="Hidden from pickers. They stay on what already carries them, and can be restored.">
        @for (l of archived(); track l.id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: l }" />
        }
      </app-settings-group>
    }

    <ng-template #row let-l>
      <div class="flex min-h-14 items-center gap-3 px-4 py-2">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            @if (catalog.canManage()) {
              <button
                type="button"
                class="focus-visible:ring-ring -m-1 min-w-0 rounded-full p-1 outline-none focus-visible:ring-2"
                [attr.aria-label]="'Edit label ' + l.name"
                (click)="openForm(l)"
              >
                <app-label-chip [labelId]="l.id" size="md" />
              </button>
            } @else {
              <app-label-chip [labelId]="l.id" size="md" />
            }
            @if (l.template) {
              <span class="text-muted-foreground text-[11px]">Template</span>
            }
          </div>
          <div class="text-muted-foreground mt-1 text-xs md:hidden">{{ usageText(l.id) }}</div>
        </div>
        <div class="text-muted-foreground hidden w-64 shrink-0 truncate text-xs md:block" [attr.title]="usageText(l.id)">{{ usageText(l.id) }}</div>
        @if (catalog.canManage()) {
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground shrink-0" [hlmDropdownMenuTrigger]="menu" [attr.aria-label]="'Actions for ' + l.name">
            <svg [lucideIcon]="more" [size]="16"></svg>
          </button>
          <ng-template #menu>
            <hlm-dropdown-menu class="w-48">
              <button hlmDropdownMenuItem (triggered)="openForm(l)">
                <svg [lucideIcon]="pencil" [size]="14"></svg>
                {{ l.template ? 'Change color' : 'Rename or recolor' }}
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
        }
      </div>
    </ng-template>

    <hlm-dialog [state]="dlg() ? 'open' : 'closed'" (closed)="closeDialog()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[90svh] overflow-y-auto sm:max-w-md">
        @switch (dlg()?.kind) {
          @case ('form') {
            <form class="contents" (submit)="submitForm($event)">
              <hlm-dialog-header>
                <h2 hlmDialogTitle>{{ editing() ? 'Edit label' : 'New label' }}</h2>
                <p hlmDialogDescription>{{ editing()?.template ? 'Templates keep their name; you can change the color.' : 'A short name people will search for.' }}</p>
              </hlm-dialog-header>
              <div class="flex flex-col gap-4 text-[13px]">
                <div class="grid gap-1.5">
                  <label class="text-muted-foreground text-xs font-medium" for="label-name">Name</label>
                  <input
                    id="label-name"
                    hlmInput
                    class="h-9 w-full"
                    autocomplete="off"
                    [attr.maxlength]="nameMax"
                    [value]="formName()"
                    [disabled]="!!editing()?.template || busy()"
                    [attr.aria-invalid]="nameError() ? 'true' : null"
                    [attr.aria-describedby]="nameError() ? 'label-name-error' : null"
                    (input)="formName.set($any($event.target).value)"
                  />
                  @if (nameError(); as e) {
                    <span id="label-name-error" class="text-destructive text-xs">{{ e }}</span>
                  }
                </div>
                <div class="grid gap-2">
                  <span class="text-muted-foreground text-xs font-medium" id="label-color-label">Color</span>
                  <div class="grid w-fit grid-cols-6 gap-2" role="radiogroup" aria-labelledby="label-color-label">
                    @for (c of swatches; track c) {
                      <button
                        type="button"
                        role="radio"
                        class="focus-visible:ring-ring flex size-7 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
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
                      class="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
                      aria-label="Pick any color"
                      [value]="colorValid() ? formColor() : '#64748b'"
                      (input)="formColor.set($any($event.target).value)"
                    />
                    <input
                      hlmInput
                      class="h-8 w-28 font-mono text-xs"
                      aria-label="Hex color"
                      maxlength="7"
                      [value]="formColor()"
                      [attr.aria-invalid]="colorValid() ? null : 'true'"
                      (input)="formColor.set($any($event.target).value)"
                    />
                  </div>
                </div>
                <div class="bg-muted/40 flex items-center gap-2 rounded-md border px-3 py-2">
                  <span class="text-muted-foreground text-xs">Preview</span>
                  <app-label-chip [name]="formName().trim() || 'Label name'" [color]="colorValid() ? formColor() : '#64748b'" size="md" />
                </div>
              </div>
              <hlm-dialog-footer>
                <button hlmBtn type="button" variant="outline" size="sm" hlmDialogClose>Cancel</button>
                <button hlmBtn type="submit" size="sm" [disabled]="!canSubmit() || busy()">{{ editing() ? 'Save' : 'Create label' }}</button>
              </hlm-dialog-footer>
            </form>
          }
          @case ('merge') {
            @if (target(); as l) {
              <hlm-dialog-header>
                <h2 hlmDialogTitle>Merge “{{ l.name }}”</h2>
                <p hlmDialogDescription>Everything labelled “{{ l.name }}” gets the label you choose instead, and “{{ l.name }}” is removed.</p>
              </hlm-dialog-header>
              <div class="flex flex-col gap-3 text-[13px]">
                <div class="grid gap-1.5">
                  <span class="text-muted-foreground text-xs font-medium">Merge into</span>
                  <app-picker
                    variant="input"
                    label="Target label"
                    placeholder="Choose a label"
                    [options]="mergeOptions()"
                    [value]="mergeInto() ? [mergeInto()] : []"
                    (valueChange)="mergeInto.set($event[0] ?? '')"
                  />
                </div>
                <div class="bg-muted/40 rounded-md border px-3 py-2 text-xs leading-relaxed">
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
                <p class="text-muted-foreground text-xs">This cannot be undone.</p>
              </div>
              <hlm-dialog-footer>
                <button hlmBtn type="button" variant="outline" size="sm" hlmDialogClose>Cancel</button>
                <button hlmBtn type="button" size="sm" [disabled]="!mergeTarget() || busy()" (click)="confirmMerge()">Merge</button>
              </hlm-dialog-footer>
            }
          }
          @case ('delete') {
            @if (target(); as l) {
              <hlm-dialog-header>
                <h2 hlmDialogTitle>Delete “{{ l.name }}”?</h2>
                <p hlmDialogDescription>The label is removed from the workspace and from everything that carries it.</p>
              </hlm-dialog-header>
              <div class="flex flex-col gap-3 text-[13px]">
                <div class="bg-muted/40 rounded-md border px-3 py-2 text-xs leading-relaxed">
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
                <p class="text-muted-foreground text-xs">Deleting cannot be undone. Archive it instead to keep it where it is and stop offering it.</p>
              </div>
              <hlm-dialog-footer>
                <button hlmBtn type="button" variant="outline" size="sm" hlmDialogClose>Cancel</button>
                @if (!l.archived) {
                  <button hlmBtn type="button" variant="outline" size="sm" [disabled]="busy()" (click)="archiveFromDelete(l)">Archive instead</button>
                }
                <button hlmBtn type="button" variant="destructive" size="sm" [disabled]="busy()" (click)="confirmDelete()">Delete label</button>
              </hlm-dialog-footer>
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

  protected readonly dlg = signal<Dialog | null>(null);
  protected readonly busy = signal(false);
  protected readonly formName = signal('');
  protected readonly formColor = signal<string>(LABEL_SWATCHES[0]);
  protected readonly mergeInto = signal('');

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

  private readonly matching = computed(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.catalog.all().filter((label) => !q || label.name.toLowerCase().includes(q));
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
  protected readonly mergeOptions = computed<PickOption[]>(() =>
    this.catalog
      .active()
      .filter((label) => label.id !== this.target()?.id)
      .map((label) => ({ value: label.id, label: label.name, kind: 'label' as const, color: label.color, hint: String(this.catalog.usageOf(label.id).total) })),
  );
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
    return !cur || name !== cur.name || this.formColor().toLowerCase() !== cur.color;
  });

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
    this.busy.set(true);
    let ok: boolean;
    if (cur) {
      ok = await this.store.updateLabel(cur.id, { ...(name !== cur.name ? { name } : {}), ...(color !== cur.color ? { color } : {}) });
    } else {
      ok = !!(await this.catalog.create(name, color));
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
