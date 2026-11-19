import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCircleDashed, LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore, type Issue } from '../../core';
import { isClosedIssue, subtaskStatus } from './issue-model';
import { IssueProp } from './issue-prop';

/**
 * Subtasks of a task, Linear style: compact rows (status, key, title, assignee) and an "Add subtask"
 * row at the end that becomes a one-line input. Enter creates the subtask and keeps the input open for the
 * next one; Esc closes it. New subtasks start in the parent's project and status.
 */
@Component({
  selector: 'app-issue-subtasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmInputImports, IssueProp, LucideDynamicIcon],
  host: { class: 'block min-w-0' },
  template: `
    @if (children().length) {
      <h2 id="issue-subtasks-heading" class="text-muted-foreground mb-1 flex items-center gap-2 text-xs font-medium">
        Subtasks
        <span class="font-normal tabular-nums">{{ doneCount() }}/{{ children().length }}</span>
      </h2>
      <ul role="list" aria-labelledby="issue-subtasks-heading" class="-mx-1 flex min-w-0 flex-col">
        @for (child of children(); track child.id) {
          <li class="hover:bg-hover flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-1 text-[13px]">
            <app-issue-prop [issue]="child" field="status" />
            <span class="text-muted-foreground w-16 shrink-0 font-mono text-xs">{{ child.key }}</span>
            <a
              [routerLink]="['/', slug(), 'tasks', child.key]"
              class="focus-visible:ring-ring min-w-0 flex-1 truncate rounded-sm outline-none hover:underline focus-visible:ring-2"
              [class.text-muted-foreground]="closed(child)"
              >{{ child.title }}</a
            >
            <app-issue-prop [issue]="child" field="assignee" [avatarSize]="16" />
          </li>
        }
      </ul>
    }

    @if (canCreate()) {
      <div class="-mx-1" [class.mt-0.5]="children().length">
        @if (adding()) {
          <div class="flex min-h-8 items-center gap-1.5 px-1">
            <span class="text-muted-foreground inline-flex size-6 shrink-0 items-center justify-center">
              <svg [lucideIcon]="draftIcon" [size]="14" aria-hidden="true"></svg>
            </span>
            <input
              #field
              hlmInput
              class="h-7 min-w-0 flex-1 text-[13px]"
              placeholder="Subtask title"
              aria-label="Subtask title"
              autocomplete="off"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="onEnter($event)"
              (keydown.escape)="close($event)"
              (blur)="onBlur()"
            />
            <span class="text-muted-foreground shrink-0 text-xs max-sm:hidden">↵ add · esc done</span>
          </div>
        } @else {
          <button
            type="button"
            class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex h-8 w-full items-center gap-1.5 rounded-md px-1 text-left text-[13px] outline-none focus-visible:ring-2"
            [attr.aria-label]="'Add subtask to ' + issue().key"
            (click)="open()"
          >
            <span class="inline-flex size-6 shrink-0 items-center justify-center">
              <svg [lucideIcon]="plusIcon" [size]="14" aria-hidden="true"></svg>
            </span>
            Add subtask
          </button>
        }
      </div>
    }
  `,
})
export class IssueSubtasks {
  private readonly store = inject(TramaStore);

  readonly issue = input.required<Issue>();

  protected readonly plusIcon = LucidePlus;
  protected readonly draftIcon = LucideCircleDashed;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canCreate = computed(() => this.store.allowed('createIssues'));
  protected readonly children = computed(() => {
    const id = this.issue().id;
    return this.store.issues().filter((i) => i.parentId === id);
  });
  protected readonly doneCount = computed(() => {
    const entries = this.store.settings().statuses.issue;
    return this.children().filter((i) => isClosedIssue(i, entries)).length;
  });

  protected readonly adding = signal(false);
  protected readonly draft = signal('');
  private readonly busy = signal(false);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  constructor() {
    effect(() => this.field()?.nativeElement.focus());
    // Another task opened in the same page: start closed.
    let last: string | undefined;
    effect(() => {
      const id = this.issue().id;
      if (last !== undefined && last !== id) {
        this.adding.set(false);
        this.draft.set('');
      }
      last = id;
    });
  }

  protected closed(issue: Issue): boolean {
    return isClosedIssue(issue, this.store.settings().statuses.issue);
  }

  protected open(): void {
    this.adding.set(true);
  }

  protected close(event?: Event): void {
    event?.stopPropagation();
    this.adding.set(false);
    this.draft.set('');
  }

  /** Leaving the input empty closes it; a typed title stays so a stray click does not lose it. */
  protected onBlur(): void {
    if (!this.draft().trim()) this.adding.set(false);
  }

  protected onEnter(event: Event): void {
    event.preventDefault();
    if ((event as KeyboardEvent).isComposing) return;
    void this.add();
  }

  private async add(): Promise<void> {
    const title = this.draft().trim();
    const parent = this.issue();
    if (!title || this.busy()) return;
    this.busy.set(true);
    try {
      const created = await this.store.createIssue({
        kind: parent.kind,
        title,
        parentId: parent.id,
        projectId: parent.projectId,
        status: subtaskStatus(parent, this.store.settings().statuses.issue),
      });
      // Keep what was typed meanwhile; on failure the store has already said why and the title stays.
      if (created && this.draft().trim() === title) this.draft.set('');
    } finally {
      this.busy.set(false);
    }
  }
}
