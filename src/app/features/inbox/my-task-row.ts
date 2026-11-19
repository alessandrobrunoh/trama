// One task row of the Inbox: status glyph, key, title, quiet chips, needs-you dot, updated.
// A single click previews the task in the right pane; Enter or a double click opens it.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  TramaStore,
  UiStore,
  resolveStatusEntry,
  Notifier,
  PRIORITY_META,
  type Issue,
  type Priority,
} from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { AgoPipe } from '../../shared/ago';
import { LabelChips } from '../../shared/label-chip';
import { NeedsYou, PreviewLink, isTaskPreviewed } from '../issues/list-preview';
import { IssueStatusMenu, PriorityMenu } from './inline-menus';

const ROW =
  'group/row hover:bg-hover flex min-h-9 items-center gap-2.5 px-4 outline-none sm:px-5';

/** One of my tasks: status · key · title · labels · priority · updated. */
@Component({
  selector: 'app-my-task-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PreviewLink, HlmTooltip, IssueStatusMenu, PriorityMenu, LabelChips, AgoPipe],
  host: { class: 'block' },
  template: `
    @let i = issue();
    <div
      [class]="row"
      [class.bg-selected]="selected()"
      [attr.data-row-id]="i.id"
      [attr.data-focused]="focused() ? '' : null"
    >
      <app-issue-status-menu [status]="i.status" [disabled]="!canEdit()" (changed)="setStatus($event)" />
      <a
        [appPreviewLink]="['/', slug(), 'tasks', i.key]"
        class="flex min-w-0 flex-1 items-center gap-2.5 self-stretch outline-none focus-visible:underline"
        [attr.aria-current]="previewed() ? 'true' : null"
        (preview)="preview()"
      >
        <span class="text-muted-foreground w-[4.5rem] shrink-0 truncate font-mono text-xs max-sm:hidden">{{ i.key }}</span>
        <span class="min-w-0 truncate text-[13px]" [class.text-muted-foreground]="quiet()">{{ i.title }}</span>
      </a>
      @if (i.labels.length) {
        <app-label-chips class="shrink-0 max-lg:hidden" [ids]="i.labels" [max]="2" />
      }
      @if (i.priority !== 'none') {
        <app-priority-menu [priority]="i.priority" [disabled]="!canEdit()" (changed)="setPriority($event)" />
      }
      @if (needsYou()) {
        <span class="bg-primary size-2 shrink-0 rounded-full" role="img" aria-label="Needs you"></span>
      }
      <span class="text-meta w-8 text-end tabular-nums" [hlmTooltip]="'Updated ' + (i.updatedAt | ago)" position="left">{{ i.updatedAt | ago }}</span>
    </div>
  `,
})
export class MyTaskRow {
  private readonly store = inject(TramaStore);
  private readonly notifier = inject(Notifier);
  private readonly ui = inject(UiStore);
  private readonly pane = inject(RightPaneStore);
  private readonly needs = inject(NeedsYou);
  readonly issue = input.required<Issue>();
  readonly focused = input(false);
  /** Mute the title (idle tasks). Done and canceled tasks are always muted. */
  readonly dim = input(false);

  protected readonly row = ROW;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly previewed = computed(() => isTaskPreviewed(this.pane, this.issue()));
  protected readonly selected = computed(() => this.previewed() || this.focused());
  protected readonly needsYou = computed(() => this.needs.issueIds().has(this.issue().id));
  protected readonly quiet = computed(() => {
    const s = this.issue().status;
    return this.dim() || s === 'done' || s === 'canceled';
  });

  protected preview(): void {
    const i = this.issue();
    this.ui.setFocusedRow(i.id);
    this.pane.show({ kind: 'task', idOrKey: i.key });
  }

  protected async setStatus(status: string): Promise<void> {
    const i = this.issue();
    const prev = i.status;
    const name = resolveStatusEntry(this.store.settings().statuses.issue, status)?.name ?? status;
    if (await this.store.updateIssue(i.id, { status })) {
      this.notifier.success(`${i.key} → ${name}`, {
        action: { label: 'Undo', run: () => void this.store.updateIssue(i.id, { status: prev }) },
      });
    }
  }

  protected async setPriority(priority: Priority): Promise<void> {
    const i = this.issue();
    const prev = i.priority;
    if (await this.store.updateIssue(i.id, { priority })) {
      this.notifier.success(`${i.key} priority → ${PRIORITY_META[priority].label}`, {
        action: { label: 'Undo', run: () => void this.store.updateIssue(i.id, { priority: prev }) },
      });
    }
  }
}
