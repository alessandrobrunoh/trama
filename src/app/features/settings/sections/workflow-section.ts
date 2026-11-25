import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  LucideDynamicIcon,
  LucidePencil,
  LucidePlus,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
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
import { V3Segmented, type V3SegmentOption } from '../../../shared/v3';
import { SECTION_KIT } from './section-kit';

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
  imports: [NgTemplateOutlet, AppSelect, HlmButtonImports, HlmDialogImports, HlmInputImports, LucideDynamicIcon, V3Segmented, ...SECTION_KIT],
  host: { class: 'flex flex-col' },
  template: `
    <app-section-header
      title="Workflow"
      description="Statuses are set by people. Linking a thread or opening a PR never changes a status on its own."
    />

    @if (!canManage()) {
      <app-readonly-note>Only admins can edit or add statuses.</app-readonly-note>
    }

    <app-settings-section title="Statuses" [caption]="caption()">
      <div aside class="flex items-center gap-3">
        <v3-segmented aria-label="Status catalogs" [options]="subjectOptions" [value]="current()" (valueChange)="setSubject($event)" />
        @if (canManage()) {
          <button hlmBtn variant="ghost" class="gap-1.5 px-2.5" (click)="openAdd()">
            <svg [lucideIcon]="plus" [size]="13"></svg>
            Add status
          </button>
        }
      </div>
      @for (entry of entries(); track entry.id) {
        <div class="border-border flex min-h-[39px] items-center gap-3.5 border-b py-2">
          <span class="w-[110px] shrink-0 sm:w-[150px]">
            <span class="border-border text-foreground inline-flex max-w-full items-center gap-1.5 border px-2 py-[3px] font-mono text-[11px] leading-[13px]">
              <span class="size-[7px] shrink-0" [style.background]="entry.color" aria-hidden="true"></span>
              <span class="truncate">{{ entry.name }}</span>
            </span>
          </span>
          <span class="text-text-2 min-w-0 flex-1 truncate text-[13px]">{{ usageText(entry) }}</span>
          <span class="text-faint hidden font-mono text-[10.5px] sm:inline">{{ typeLabel(entry.type) }}</span>
          @if (canManage()) {
            <span class="flex shrink-0 items-center">
              <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground size-6" [attr.aria-label]="'Edit ' + entry.name" (click)="openEdit(entry)">
                <svg [lucideIcon]="pencil" [size]="13"></svg>
              </button>
              <button
                hlmBtn
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground size-6"
                [disabled]="!canRemove(entry)"
                [attr.aria-label]="'Remove ' + entry.name"
                [attr.title]="removeHint(entry)"
                (click)="openDelete(entry)"
              >
                <svg [lucideIcon]="trash" [size]="13"></svg>
              </button>
            </span>
          }
        </div>
      }
    </app-settings-section>

    <hlm-dialog [state]="dlg() ? 'open' : 'closed'" (closed)="dlg.set(null)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[90svh] overflow-y-auto sm:max-w-md">
        @switch (dlg()?.kind) {
          @case ('edit') {
            <form class="contents" (submit)="save($event)">
              <hlm-dialog-header>
                <h2 hlmDialogTitle>Edit status</h2>
                <p hlmDialogDescription>The type stays {{ typeLabel(editing()?.type ?? '') }}. Name, icon and color can change.</p>
              </hlm-dialog-header>
              <ng-container *ngTemplateOutlet="fields; context: { showType: false }" />
              <hlm-dialog-footer>
                <button hlmBtn type="button" variant="outline" (click)="dlg.set(null)">Cancel</button>
                <button hlmBtn type="submit" [disabled]="busy() || !valid()">Save</button>
              </hlm-dialog-footer>
            </form>
          }
          @case ('add') {
            <form class="contents" (submit)="save($event)">
              <hlm-dialog-header>
                <h2 hlmDialogTitle>New {{ labels[current()].toLowerCase() }} status</h2>
                <p hlmDialogDescription>Pick the type it behaves as, plus an icon and a color. The name starts as that type's name.</p>
              </hlm-dialog-header>
              <ng-container *ngTemplateOutlet="fields; context: { showType: true }" />
              <hlm-dialog-footer>
                <button hlmBtn type="button" variant="outline" (click)="dlg.set(null)">Cancel</button>
                <button hlmBtn type="submit" [disabled]="busy() || !valid()">Add status</button>
              </hlm-dialog-footer>
            </form>
          }
        }
      </hlm-dialog-content>
    </hlm-dialog>

    <ng-template #fields let-showType="showType">
      <div class="flex flex-col gap-4 text-[13px]">
        <div class="grid gap-1.5">
          <label class="text-muted-foreground text-xs font-medium" for="status-name">Name</label>
          <input id="status-name" hlmInput class="h-9 w-full" autocomplete="off" [attr.maxlength]="nameMax" [value]="formName()" (input)="formName.set($any($event.target).value)" />
        </div>
        @if (showType) {
          <div class="grid gap-1.5">
            <label class="text-muted-foreground text-xs font-medium" for="status-type">Type</label>
            <app-select controlId="status-type" [options]="typeOptions()" [value]="formType()" (valueChange)="setType($event)" />
          </div>
        }
        <div class="grid gap-1.5">
          <label class="text-muted-foreground text-xs font-medium" for="status-icon">Icon</label>
          <input id="status-icon" hlmInput class="h-9 w-full" autocomplete="off" placeholder="circle-check or an emoji" [value]="formIcon()" (input)="formIcon.set($any($event.target).value)" />
          <div class="flex flex-wrap gap-1">
            @for (name of iconChoices; track name) {
              <button type="button" class="hover:bg-accent inline-flex size-7 items-center justify-center rounded-md border" [class.bg-accent]="formIcon() === name" [attr.aria-label]="name" (click)="formIcon.set(name)">
                <svg [lucideIcon]="iconFor(name)" [size]="14"></svg>
              </button>
            }
          </div>
          @if (iconError()) {
            <span class="text-destructive text-xs">Use a Lucide name like circle-check, or one emoji.</span>
          }
        </div>
        <div class="grid gap-1.5">
          <label class="text-muted-foreground text-xs font-medium" for="status-color">Color</label>
          <div class="flex items-center gap-2">
            <input id="status-color" type="color" class="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-1" [value]="colorValue()" (input)="formColor.set($any($event.target).value)" />
            <input hlmInput class="h-9 w-full font-mono" [value]="formColor()" maxlength="7" (input)="formColor.set($any($event.target).value)" aria-label="Hex color" />
          </div>
          @if (colorError()) {
            <span class="text-destructive text-xs">Color must be #rrggbb.</span>
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
  protected readonly subjectOptions: V3SegmentOption[] = this.subjects.map((s) => ({
    value: s,
    label: STATUS_SUBJECT_LABEL[s],
  }));
  protected readonly labels = STATUS_SUBJECT_LABEL;
  protected readonly nameMax = STATUS_NAME_MAX;
  protected readonly iconChoices = [...STATUS_LUCIDE.keys()];
  protected readonly plus = LucidePlus;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;

  protected readonly current = signal<StatusSubject>('issue');
  protected readonly dlg = signal<Dialog | null>(null);
  protected readonly busy = signal(false);
  protected readonly formName = signal('');
  protected readonly formIcon = signal('circle');
  protected readonly formColor = signal('#5f6a7a');
  protected readonly formType = signal('todo');

  protected readonly canManage = computed(() => this.store.can('admin'));
  protected readonly caption = computed(() => {
    const n = this.entries().length;
    return `${this.labels[this.current()].toLowerCase()} · ${n} ${n === 1 ? 'status' : 'statuses'}`;
  });
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

  protected usageText(entry: StatusEntry): string {
    const n = this.usage(entry);
    return n === 0 ? 'Not used' : `${n} in use`;
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

  protected openAdd(): void {
    const type = this.types()[0] ?? 'todo';
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
