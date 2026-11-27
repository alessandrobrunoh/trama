import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  LucideDynamicIcon,
  LucideEllipsis,
  LucideInfo,
  LucidePencil,
  LucidePlus,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  STATUS_CATALOG_KEY,
  STATUS_COLOR,
  STATUS_NAME_MAX,
  STATUS_SUBJECTS,
  STATUS_SUBJECT_LABEL,
  isStatusIcon,
  statusStoredValues,
  statusTypeLabel,
  statusTypes,
  type StatusEntry,
  type StatusSubject,
} from '../../../core/contracts/domain';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { AppSelect, type Option } from '../../../shared/app-select';
import { isLucideName, STATUS_LUCIDE } from '../../../shared/lucide-names';
import { V3_FIELD, V3DialogFoot, V3DialogHead } from '../../../shared/v3';
import { SECTION_KIT, type SegmentedOption } from './section-kit';

/** How a status counts (v4 frame 05): the four categories the types fall into, in flow order. */
const CATEGORIES: readonly { id: string; title: string; caption: string; types: readonly string[] }[] = [
  { id: 'not-started', title: 'NOT STARTED', caption: 'Not counted in progress yet.', types: ['draft', 'backlog', 'todo', 'planned'] },
  { id: 'started', title: 'STARTED', caption: 'Counts towards progress; timers can run.', types: ['in_progress', 'in_review', 'paused'] },
  { id: 'completed', title: 'COMPLETED', caption: 'Closes the task and stops timers.', types: ['done', 'completed'] },
  { id: 'canceled', title: 'CANCELED', caption: 'Closes the task without counting it as done.', types: ['canceled'] },
];

/** One line on what each status type means, shown beside the status. */
const TYPE_HINT: Readonly<Record<string, string>> = {
  draft: 'Ideas, agent proposals, half-written tasks',
  backlog: 'Ideas and work nobody has picked up yet',
  todo: 'Agreed and ready to pick up',
  planned: 'Agreed and scheduled',
  in_progress: 'Someone, or an agent, is on it',
  in_review: 'A pull request or a deliverable is waiting for review, or blocked on someone',
  paused: 'Started, then put on hold',
  done: 'Shipped. Closed by a merged PR or by hand',
  completed: 'Shipped and closed',
  canceled: "Won't do, duplicate or obsolete. Still searchable",
};

type Dialog =
  | { kind: 'edit'; entry: StatusEntry }
  | { kind: 'add' };

/**
 * Settings · Workflow (v3 frame 13): the status catalogs. Name, icon and color are yours; the type is what
 * boards, done and canceled still mean, so a new status picks a type that already exists.
 */
@Component({
  selector: 'app-workflow-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, AppSelect, HlmButtonImports, HlmDialogImports, HlmDropdownMenuImports, LucideDynamicIcon, V3DialogFoot, V3DialogHead, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Workflow"
      description="The statuses a task moves through. The category decides how a status counts."
    >
      <app-segmented actions aria-label="Status catalogs" [options]="subjectOptions" [value]="current()" (valueChange)="setSubject($event)" />
    </app-section-header>

    @if (!canManage()) {
      <app-readonly-note class="mb-0!">Only admins can edit or add statuses.</app-readonly-note>
    }

    @if (flow().length) {
      <div class="flex flex-col gap-2">
        <div class="flex h-2 w-full gap-0.5 overflow-hidden" role="img" [attr.aria-label]="'Share of ' + subjectNoun() + ' by status'">
          @for (s of flow(); track s.id) {
            @if (s.count > 0) {
              <span class="h-2 min-w-0" [style.flex]="s.count + ' 1 0'" [style.background]="s.color" [attr.title]="s.name + ' ' + s.count"></span>
            }
          }
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          @for (s of flow(); track s.id) {
            <span class="text-muted-foreground inline-flex items-center gap-[5px] font-mono text-[10.5px] leading-[normal]">
              <span class="size-1.5 shrink-0" [style.background]="s.color" aria-hidden="true"></span>
              {{ s.name }} {{ s.count }}
            </span>
          }
        </div>
      </div>
    }

    <div class="bg-card border-border divide-border divide-y border">
      @for (g of groups(); track g.id) {
        <section [attr.aria-label]="g.title">
          <div class="bg-bg-deep flex items-center gap-2.5 px-3 py-2.5">
            <span class="text-text-2 font-mono text-[10.5px] leading-[normal]">{{ g.title }}</span>
            <span class="text-faint min-w-0 truncate font-mono text-[10.5px] leading-[normal]">{{ g.caption }}</span>
            <span class="flex-1"></span>
            @if (canManage()) {
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 font-mono text-[10.5px] leading-[normal] outline-none focus-visible:ring-2"
                (click)="openAdd(g.types[0])"
              >
                <svg [lucideIcon]="plus" [size]="12"></svg>
                Add
              </button>
            }
          </div>
          @for (entry of g.entries; track entry.id) {
            <div class="border-border hover:bg-hover/40 flex items-center gap-3 border-t py-[9px] pr-3 pl-4">
              <span class="flex w-[15px] shrink-0 items-center justify-center" [style.color]="entry.color" aria-hidden="true">
                @if (emoji(entry.icon); as e) {
                  <span class="text-[13px] leading-none">{{ e }}</span>
                } @else {
                  <svg [lucideIcon]="iconFor(entry.icon)" [size]="15"></svg>
                }
              </span>
              <span class="text-foreground w-[132px] shrink-0 truncate text-[13px] leading-[normal] sm:w-[180px]">{{ entry.name }}</span>
              <span class="text-muted-foreground hidden min-w-0 flex-1 truncate text-[12.5px] leading-[normal] sm:block">{{ hint(entry) }}</span>
              <span class="flex-1 sm:hidden"></span>
              <span class="text-faint shrink-0 font-mono text-[10.5px] leading-[normal]">{{ usage(entry) }} {{ subjectNoun() }}</span>
              @if (canManage()) {
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -m-1 shrink-0 p-1 outline-none focus-visible:ring-2"
                  [hlmDropdownMenuTrigger]="statusMenu"
                  [attr.aria-label]="'Actions for ' + entry.name"
                >
                  <svg [lucideIcon]="ellipsis" [size]="14"></svg>
                </button>
                <ng-template #statusMenu>
                  <hlm-dropdown-menu class="w-40">
                    <button hlmDropdownMenuItem (triggered)="openEdit(entry)">
                      <svg [lucideIcon]="pencil" [size]="14" class="text-muted-foreground"></svg> Edit
                    </button>
                    <button
                      hlmDropdownMenuItem
                      variant="destructive"
                      [disabled]="!canRemove(entry)"
                      [attr.title]="removeHint(entry)"
                      (triggered)="openDelete(entry)"
                    >
                      <svg [lucideIcon]="trash" [size]="14"></svg> Remove
                    </button>
                  </hlm-dropdown-menu>
                </ng-template>
              }
            </div>
          }
        </section>
      }
    </div>

    <div class="bg-card border-border flex items-start gap-2.5 border px-3.5 py-2.5">
      <svg [lucideIcon]="info" [size]="14" class="text-muted-foreground mt-[3px] shrink-0"></svg>
      <p class="text-text-2 flex-1 text-[12.5px] leading-[19px]">
        Canceled isn't Trash: canceled {{ subjectNoun() }} stay in lists and search, closed.
      </p>
    </div>

    <hlm-dialog [state]="dlg() ? 'open' : 'closed'" (closed)="dlg.set(null)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[90svh] gap-0 overflow-y-auto p-0 sm:max-w-md" [showCloseButton]="false">
        @switch (dlg()?.kind) {
          @case ('edit') {
            <form class="contents" (submit)="save($event)">
              <v3-dialog-head kicker="STATUS" (dismiss)="dlg.set(null)">
                <h2 hlmDialogTitle>Edit status</h2>
              </v3-dialog-head>
              <p hlmDialogDescription class="text-muted-foreground px-[18px] pt-3.5 text-[12.5px] leading-snug">The type stays {{ typeLabel(editing()?.type ?? '') }}. Name, icon and color can change.</p>
              <ng-container *ngTemplateOutlet="fields; context: { showType: false }" />
              <v3-dialog-foot>
                <button hlmBtn type="button" variant="outline" (click)="dlg.set(null)">Cancel</button>
                <button hlmBtn type="submit" [disabled]="busy() || !valid()">Save</button>
              </v3-dialog-foot>
            </form>
          }
          @case ('add') {
            <form class="contents" (submit)="save($event)">
              <v3-dialog-head kicker="NEW STATUS" (dismiss)="dlg.set(null)">
                <h2 hlmDialogTitle>New {{ labels[current()].toLowerCase() }} status</h2>
              </v3-dialog-head>
              <p hlmDialogDescription class="text-muted-foreground px-[18px] pt-3.5 text-[12.5px] leading-snug">Pick the type it behaves as, plus an icon and a color. The name starts as that type's name.</p>
              <ng-container *ngTemplateOutlet="fields; context: { showType: true }" />
              <v3-dialog-foot>
                <button hlmBtn type="button" variant="outline" (click)="dlg.set(null)">Cancel</button>
                <button hlmBtn type="submit" [disabled]="busy() || !valid()">Add status</button>
              </v3-dialog-foot>
            </form>
          }
        }
      </hlm-dialog-content>
    </hlm-dialog>

    <ng-template #fields let-showType="showType">
      <div class="flex flex-col gap-4 p-[18px] text-[13px]">
        <div class="flex flex-col gap-1.5">
          <label class="text-faint font-mono text-[10.5px] leading-[14px]" for="status-name">NAME</label>
          <input id="status-name" [class]="fieldClass" autocomplete="off" [attr.maxlength]="nameMax" [value]="formName()" (input)="formName.set($any($event.target).value)" />
        </div>
        @if (showType) {
          <div class="flex flex-col gap-1.5">
            <label class="text-faint font-mono text-[10.5px] leading-[14px]" for="status-type">TYPE</label>
            <app-select controlId="status-type" [options]="typeOptions()" [value]="formType()" (valueChange)="setType($event)" />
          </div>
        }
        <div class="flex flex-col gap-1.5">
          <label class="text-faint font-mono text-[10.5px] leading-[14px]" for="status-icon">ICON</label>
          <input id="status-icon" [class]="fieldClass" autocomplete="off" placeholder="circle-check or an emoji" [value]="formIcon()" (input)="formIcon.set($any($event.target).value)" />
          <div class="flex flex-wrap gap-1">
            @for (name of iconChoices; track name) {
              <button type="button" class="border-border hover:bg-secondary inline-flex size-7 items-center justify-center border" [class.bg-selected]="formIcon() === name" [class.border-primary]="formIcon() === name" [attr.aria-label]="name" (click)="formIcon.set(name)">
                <svg [lucideIcon]="iconFor(name)" [size]="14"></svg>
              </button>
            }
          </div>
          @if (iconError()) {
            <span class="text-red font-mono text-[10.5px]">Use a Lucide name like circle-check, or one emoji.</span>
          }
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-faint font-mono text-[10.5px] leading-[14px]" for="status-color">COLOR</label>
          <div class="flex items-center gap-2">
            <input id="status-color" type="color" class="border-border size-[34px] shrink-0 cursor-pointer border bg-transparent p-1" [value]="colorValue()" (input)="formColor.set($any($event.target).value)" />
            <input [class]="fieldClass + ' font-mono'" [value]="formColor()" maxlength="7" (input)="formColor.set($any($event.target).value)" aria-label="Hex color" />
          </div>
          @if (colorError()) {
            <span class="text-red font-mono text-[10.5px]">Color must be #rrggbb.</span>
          }
        </div>
      </div>
    </ng-template>
  `,
})
export class WorkflowSection {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  /** Project health went away with project updates: only task and project statuses are configurable. */
  protected readonly subjects = STATUS_SUBJECTS.filter((s) => s === 'issue' || s === 'project');
  protected readonly subjectOptions: SegmentedOption[] = this.subjects.map((s) => ({
    value: s,
    label: s === 'issue' ? 'Tasks' : STATUS_SUBJECT_LABEL[s],
  }));
  protected readonly fieldClass = V3_FIELD;
  protected readonly labels = STATUS_SUBJECT_LABEL;
  protected readonly nameMax = STATUS_NAME_MAX;
  protected readonly iconChoices = [...STATUS_LUCIDE.keys()];
  protected readonly plus = LucidePlus;
  protected readonly ellipsis = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly info = LucideInfo;

  protected readonly current = signal<StatusSubject>('issue');
  protected readonly dlg = signal<Dialog | null>(null);
  protected readonly busy = signal(false);
  protected readonly formName = signal('');
  protected readonly formIcon = signal('circle');
  protected readonly formColor = signal('#5f6a7a');
  protected readonly formType = signal('todo');

  protected readonly canManage = computed(() => this.store.can('admin'));
  protected readonly subjectNoun = computed(() => (this.current() === 'issue' ? 'tasks' : 'projects'));
  /** Statuses in category order: the catalog order inside each category. A custom type lands in the last. */
  protected readonly groups = computed(() => {
    const entries = this.entries();
    return CATEGORIES.map((c) => ({
      ...c,
      types: c.types.filter((t) => this.types().includes(t)),
      entries: entries.filter((e) => c.types.includes(e.type)),
    })).filter((g) => g.types.length > 0 || g.entries.length > 0);
  });
  /** The bar and legend under the title: how many records sit in each status. */
  protected readonly flow = computed(() =>
    this.groups()
      .flatMap((g) => g.entries)
      .map((e) => ({ id: e.id, name: e.name, color: e.color, count: this.usage(e) })),
  );
  protected hint(entry: StatusEntry): string {
    return TYPE_HINT[entry.type] ?? this.typeLabel(entry.type);
  }
  protected setSubject(value: string): void {
    const subject = this.subjects.find((s) => s === value);
    if (subject) this.current.set(subject);
  }
  protected readonly entries = computed(() => this.store.settings().statuses[STATUS_CATALOG_KEY[this.current()]]);
  protected readonly types = computed(() => statusTypes(this.current()));
  protected readonly typeOptions = computed<Option[]>(() =>
    this.types().map((type) => ({ value: type, label: this.typeLabel(type) })),
  );
  protected readonly editing = computed(() => {
    const dialog = this.dlg();
    return dialog?.kind === 'edit' ? dialog.entry : null;
  });
  protected typeLabel(type: string): string {
    return statusTypeLabel(this.current(), type);
  }

  protected iconFor(name: string) {
    return STATUS_LUCIDE.get(name) ?? STATUS_LUCIDE.get('circle')!;
  }

  protected emoji(icon: string): string | null {
    return isLucideName(icon) ? null : icon;
  }

  protected usage(entry: StatusEntry): number {
    const values = new Set(statusStoredValues(entry, this.entries()));
    const has = (stored: string | null | undefined) => !!stored && values.has(stored);
    const store = this.store;
    switch (this.current()) {
      case 'issue':
        return store.issues().filter((issue) => has(issue.status)).length;
      case 'project':
        return store.projects().filter((project) => has(project.status)).length;
      default:
        return 0;
    }
  }

  protected canRemove(entry: StatusEntry): boolean {
    return this.usage(entry) === 0 && this.entries().filter((item) => item.type === entry.type).length > 1;
  }

  protected removeHint(entry: StatusEntry): string {
    if (this.usage(entry) > 0) return 'Still in use';
    if (this.entries().filter((item) => item.type === entry.type).length <= 1) return 'Keep one of this type';
    return 'Remove';
  }

  protected iconError(): boolean {
    const icon = this.formIcon().trim();
    return icon.length > 0 && !isStatusIcon(icon);
  }

  protected colorError(): boolean {
    return !STATUS_COLOR.test(this.formColor().trim());
  }

  protected colorValue(): string {
    return STATUS_COLOR.test(this.formColor().trim()) ? this.formColor().trim() : '#5f6a7a';
  }

  protected valid(): boolean {
    const name = this.formName().trim();
    return name.length > 0 && name.length <= STATUS_NAME_MAX && isStatusIcon(this.formIcon().trim()) && STATUS_COLOR.test(this.formColor().trim());
  }

  protected openEdit(entry: StatusEntry): void {
    this.formName.set(entry.name);
    this.formIcon.set(entry.icon);
    this.formColor.set(entry.color);
    this.formType.set(entry.type);
    this.dlg.set({ kind: 'edit', entry });
  }

  protected openAdd(preferred?: string): void {
    const type = preferred ?? this.types()[0] ?? 'todo';
    this.formType.set(type);
    this.formName.set(statusTypeLabel(this.current(), type));
    this.formIcon.set('circle');
    this.formColor.set('#5f6a7a');
    this.dlg.set({ kind: 'add' });
  }

  protected openDelete(entry: StatusEntry): void {
    if (!this.canRemove(entry)) return;
    this.ui.setConfirmDelete({
      title: `Remove ${entry.name}?`,
      description: 'Nothing is using it. This does not change the type other statuses still have.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.deleteStatus(this.current(), entry.id);
      },
    });
  }

  protected setType(type: string): void {
    const previous = statusTypeLabel(this.current(), this.formType());
    this.formType.set(type);
    if (!this.formName().trim() || this.formName().trim() === previous) this.formName.set(statusTypeLabel(this.current(), type));
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.valid() || this.busy()) return;
    const input = { name: this.formName().trim(), icon: this.formIcon().trim(), color: this.formColor().trim() };
    this.busy.set(true);
    const dialog = this.dlg();
    const ok =
      dialog?.kind === 'edit'
        ? await this.store.updateStatus(this.current(), dialog.entry.id, input)
        : await this.store.createStatus(this.current(), { ...input, type: this.formType() });
    this.busy.set(false);
    if (ok) this.dlg.set(null);
  }

}
