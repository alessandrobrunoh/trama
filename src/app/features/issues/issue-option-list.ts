// Searchable option list (status / priority / assignee / project / duplicate) for one or more
// issues. Used inside the row/card popovers and the keyboard command dialog. Digits 1–9 pick directly.
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LucideCheck, LucideDynamicIcon, LucideUserMinus } from '@lucide/angular';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { LABEL_NAME_MAX, TramaStore } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { LabelCatalog } from '../../shared/label-catalog';
import { IssueActions, type IssuePromptField } from './issue-actions';
import { IssueOptionGlyph, PROMPT_TITLE, applyOption, currentValues, promptOptions, type IssueOption } from './issue-options';

/** Value prefix of the "Create label" row. */
const CREATE = '__create:';

@Component({
  selector: 'app-issue-option-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, LucideDynamicIcon, IssueOptionGlyph, ActorAvatar],
  host: { class: 'block min-w-0' },
  template: `
    <hlm-command class="h-auto max-h-[22rem] rounded-lg" [(search)]="query" (keydown)="onKey($event)">
      <hlm-command-input [placeholder]="placeholder()" />
      <div *hlmCommandEmptyState hlmCommandEmpty>No matches.</div>
      <hlm-command-list class="max-h-72">
        <hlm-command-group class="p-1">
          @for (o of rows(); track o.value; let n = $index) {
            <button hlmCommandItem class="px-2" [value]="o.search + ' ' + o.value" (selected)="pick(o)">
              @if (people() && o.glyph === 'user') {
                <app-actor-avatar [actor]="{ type: 'user', id: o.value }" [size]="22" />
              } @else {
                <app-issue-option-glyph [option]="o" />
              }
              @if (o.hint && field() === 'duplicate') {
                <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ o.hint }}</span>
              }
              <span
                class="group-data-selected/command-item:text-foreground min-w-0 flex-1 truncate"
                [class.text-muted-foreground]="people() && !current().has(o.value)"
                >{{ o.label }}</span
              >
              @if (o.hint && people()) {
                <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ o.hint }}</span>
              }
              @if (current().has(o.value)) {
                <svg [lucideIcon]="check" [size]="14" class="text-foreground shrink-0"></svg>
              }
              @if (n < 9 && digits()) {
                <span class="text-faint w-3 shrink-0 text-right font-mono text-[10.5px]">{{ n + 1 }}</span>
              }
            </button>
          }
        </hlm-command-group>
        @if (clearRow(); as c) {
          <div class="bg-border h-px w-full" role="separator"></div>
          <hlm-command-group class="p-1">
            <button hlmCommandItem class="px-3" [value]="c.search + ' ' + c.value" (selected)="pick(c)">
              <svg [lucideIcon]="unassign" [size]="14" class="text-muted-foreground shrink-0"></svg>
              <span class="text-muted-foreground min-w-0 flex-1 truncate">{{ c.label }}</span>
              @if (current().has('')) {
                <svg [lucideIcon]="check" [size]="14" class="text-foreground shrink-0"></svg>
              } @else {
                <span class="text-faint shrink-0 font-mono text-[10.5px]">⌫</span>
              }
            </button>
          </hlm-command-group>
        }
      </hlm-command-list>
    </hlm-command>
  `,
})
export class IssueOptionList {
  private readonly store = inject(TramaStore);
  private readonly actions = inject(IssueActions);
  private readonly catalog = inject(LabelCatalog);

  readonly field = input.required<IssuePromptField>();
  readonly ids = input.required<readonly string[]>();
  /** Emits after an option was applied. */
  readonly done = output<void>();

  protected readonly query = signal('');
  protected readonly check = LucideCheck;
  protected readonly unassign = LucideUserMinus;
  private readonly issues = computed(() => this.actions.issues(this.ids()));
  protected readonly current = computed(() => currentValues(this.field(), this.issues()));
  protected readonly options = computed(() => {
    if (this.field() !== 'label') return promptOptions(this.store, this.field(), this.issues());
    // Same labels, same order as the label picker; a typed name that matches nothing can be created on the spot.
    const { suggested, rest } = this.catalog.arrange(this.current(), !this.query().trim(), 'issue');
    const list = promptOptions(this.store, 'label', this.issues(), [...suggested, ...rest]);
    const name = this.query().trim();
    if (!name || name.length > LABEL_NAME_MAX || !this.catalog.canCreate() || this.catalog.find(name)) return list;
    return [...list, { value: CREATE + name, label: `Create “${name}”`, glyph: 'label' as const, color: this.catalog.nextColor(), search: name }];
  });
  /** People picker (v3 · 17): 22px avatars, open-task counts, "Unassign" as a separate last row. */
  protected readonly people = computed(() => this.field() === 'assignee');
  protected readonly clearRow = computed(() =>
    this.people() ? (this.options().find((o) => o.value === '') ?? null) : null,
  );
  protected readonly rows = computed(() =>
    this.people() ? this.options().filter((o) => o.value !== '') : this.options(),
  );
  protected readonly placeholder = computed(() => PROMPT_TITLE[this.field()]);
  /** Number hints only for short, fixed lists. */
  protected readonly digits = computed(() => this.field() === 'status' || this.field() === 'priority');

  protected pick(o: IssueOption): void {
    if (o.value.startsWith(CREATE)) {
      void this.createAndToggle(o.value.slice(CREATE.length));
      return;
    }
    if (applyOption(this.actions, this.field(), this.ids(), o.value)) this.done.emit();
  }

  private async createAndToggle(name: string): Promise<void> {
    const made = await this.catalog.create(name, undefined, 'issue');
    if (!made) return;
    this.query.set('');
    this.catalog.touch(made.id);
    this.actions.toggleLabel(this.ids(), made.id);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Backspace' && this.people() && !this.query()) {
      const c = this.clearRow();
      if (c && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.pick(c);
        return;
      }
    }
    if (!this.digits() || this.query() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const o = this.options()[Number(e.key) - 1];
    if (!o) return;
    e.preventDefault();
    e.stopPropagation();
    this.pick(o);
  }
}
