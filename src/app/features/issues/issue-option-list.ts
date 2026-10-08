// Searchable option list (status / priority / assignee / team / workstream / duplicate) for one or more
// issues. Used inside the row/card popovers and the keyboard command dialog. Digits 1–9 pick directly.
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LucideCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { NablaStore } from '../../core';
import { IssueActions, type IssuePromptField } from './issue-actions';
import { IssueOptionGlyph, PROMPT_TITLE, applyOption, currentValues, promptOptions, type IssueOption } from './issue-options';

@Component({
  selector: 'app-issue-option-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, LucideDynamicIcon, IssueOptionGlyph],
  host: { class: 'block' },
  template: `
    <hlm-command class="h-auto max-h-[22rem] rounded-lg" [(search)]="query" (keydown)="onKey($event)">
      <hlm-command-input [placeholder]="placeholder()" />
      <div *hlmCommandEmptyState hlmCommandEmpty>No matches.</div>
      <hlm-command-list class="max-h-72">
        <hlm-command-group>
          @for (o of options(); track o.value; let n = $index) {
            <button hlmCommandItem [value]="o.search + ' ' + o.value" (selected)="pick(o)">
              <app-issue-option-glyph [option]="o" />
              @if (o.hint && (field() === 'workstream' || field() === 'duplicate')) {
                <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ o.hint }}</span>
              }
              <span class="min-w-0 flex-1 truncate">{{ o.label }}</span>
              @if (current().has(o.value)) {
                <svg [lucideIcon]="check" [size]="14" class="text-foreground shrink-0"></svg>
              }
              @if (o.hint && field() === 'team') {
                <span class="text-muted-foreground font-mono text-[11px]">{{ o.hint }}</span>
              } @else if (n < 9 && digits()) {
                <span class="text-muted-foreground w-3 shrink-0 text-right font-mono text-[11px]">{{ n + 1 }}</span>
              }
            </button>
          }
        </hlm-command-group>
      </hlm-command-list>
    </hlm-command>
  `,
})
export class IssueOptionList {
  private readonly store = inject(NablaStore);
  private readonly actions = inject(IssueActions);

  readonly field = input.required<IssuePromptField>();
  readonly ids = input.required<readonly string[]>();
  /** Emits after an option was applied. */
  readonly done = output<void>();

  protected readonly query = signal('');
  protected readonly check = LucideCheck;
  private readonly issues = computed(() => this.actions.issues(this.ids()));
  protected readonly options = computed(() => promptOptions(this.store, this.field(), this.issues()));
  protected readonly current = computed(() => currentValues(this.field(), this.issues()));
  protected readonly placeholder = computed(() => PROMPT_TITLE[this.field()]);
  /** Number hints only for short, fixed lists. */
  protected readonly digits = computed(() => this.field() === 'status' || this.field() === 'priority');

  protected pick(o: IssueOption): void {
    if (applyOption(this.actions, this.field(), this.ids(), o.value)) this.done.emit();
  }

  protected onKey(e: KeyboardEvent): void {
    if (!this.digits() || this.query() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const o = this.options()[Number(e.key) - 1];
    if (!o) return;
    e.preventDefault();
    e.stopPropagation();
    this.pick(o);
  }
}
