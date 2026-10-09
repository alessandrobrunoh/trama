import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LucideCopy, LucideDynamicIcon, LucideExternalLink, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { Issue, Workstream } from '../core/contracts/domain';
import { usePageShortcuts } from '../core/keyboard/keyboard-shortcuts.service';
import { Clipboard } from '../core/notify/notifier';
import { NablaStore } from '../core/stores/nabla.store';
import { PeekStore } from '../core/stores/peek.store';
import { UiStore } from '../core/stores/ui.store';
import { shortDate } from '../core/format';
import { ActorLabel } from './actor-avatar';
import { EntityChip } from './entity-chip';
import { EntityRefs } from './entity-ref';
import { IssueKindLabel } from './issue';
import { Kbd } from './kbd';
import { Markdown } from './markdown';
import { PriorityIcon } from './priority-icon';
import { StatusLabel } from './status';

/** Elements that own the Space key when they have focus. */
const OWNS_SPACE = 'button, input, textarea, select, summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [contenteditable="true"]';

/**
 * Side preview of the list row that has keyboard focus. Mount once inside a positioned list container.
 * Space toggles it, j/k (or the arrows) move to the next row, Enter opens the full page, Esc closes.
 * Registers its shortcuts only while mounted, so pages without a panel keep Space as "select".
 */
@Component({
  selector: 'app-peek-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorLabel, EntityChip, HlmButtonImports, IssueKindLabel, Kbd, LucideDynamicIcon, Markdown, PriorityIcon, StatusLabel],
  template: `
    @if (peek.open()) {
      <aside
        class="bg-background border-border-strong absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l shadow-[var(--shadow-menu)] sm:w-[26rem]"
        role="complementary"
        aria-label="Preview"
        data-testid="peek-panel"
      >
        <div class="flex h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-4 text-xs">
          <span class="text-muted-foreground">Preview</span>
          <span class="text-muted-foreground ml-auto flex items-center gap-1 max-sm:hidden"><app-kbd keys="j k" /> next / previous</span>
          <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground" aria-label="Close preview" (click)="peek.close()">
            <svg [lucideIcon]="xIcon" [size]="14"></svg>
          </button>
        </div>

        @if (issue(); as i) {
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <div class="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
              <app-issue-kind [kind]="i.kind" [size]="13" />{{ i.key }}
            </div>
            <h2 class="mt-1 text-base leading-snug font-semibold">{{ i.title }}</h2>
            <dl class="mt-4 grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
              <dt class="text-muted-foreground">Status</dt>
              <dd><app-status-label [status]="i.status" entity="issue" /></dd>
              <dt class="text-muted-foreground">Priority</dt>
              <dd><app-priority-icon [priority]="i.priority" showLabel /></dd>
              <dt class="text-muted-foreground">Assignee</dt>
              <dd>
                @if (i.assigneeId) {
                  <app-actor [actor]="{ type: 'user', id: i.assigneeId }" [size]="18" />
                } @else {
                  <span class="text-muted-foreground">Unassigned</span>
                }
              </dd>
              @if (teamName(i.teamId); as t) {
                <dt class="text-muted-foreground">Team</dt>
                <dd>{{ t }}</dd>
              }
              @if (projectName(i.projectId); as p) {
                <dt class="text-muted-foreground">Project</dt>
                <dd class="truncate">{{ p }}</dd>
              }
              @if (labels(i.labels).length) {
                <dt class="text-muted-foreground">Labels</dt>
                <dd class="flex flex-wrap gap-1">
                  @for (l of labels(i.labels); track l.id) {
                    <span class="border-border-strong inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
                      <span class="size-2 rounded-full" [style.background]="l.color"></span>{{ l.name }}
                    </span>
                  }
                </dd>
              }
              @if (i.workstreamIds.length) {
                <dt class="text-muted-foreground">Workstreams</dt>
                <dd class="flex min-w-0 flex-col items-start gap-1">
                  @for (w of i.workstreamIds; track w) {
                    <app-entity-chip type="workstream" [ref]="w" />
                  }
                </dd>
              }
              <dt class="text-muted-foreground">Updated</dt>
              <dd class="text-muted-foreground">{{ date(i.updatedAt) }}</dd>
            </dl>
            @if (i.body) {
              <div class="mt-5 border-t pt-4 text-[13px]"><app-markdown [source]="i.body" [link]="refs.linker()" /></div>
            } @else {
              <p class="text-muted-foreground mt-5 border-t pt-4 text-[13px]">No description.</p>
            }
          </div>
        } @else if (workstream(); as w) {
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <div class="text-muted-foreground font-mono text-[11px]">{{ w.key }}</div>
            <h2 class="mt-1 text-base leading-snug font-semibold">{{ w.title }}</h2>
            <dl class="mt-4 grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
              <dt class="text-muted-foreground">Status</dt>
              <dd><app-status-label [status]="w.status" entity="workstream" /></dd>
              <dt class="text-muted-foreground">Priority</dt>
              <dd><app-priority-icon [priority]="w.priority" showLabel /></dd>
              <dt class="text-muted-foreground">Accountable</dt>
              <dd>
                @if (w.accountableUserId) {
                  <app-actor [actor]="{ type: 'user', id: w.accountableUserId }" [size]="18" />
                } @else {
                  <span class="text-muted-foreground">Nobody</span>
                }
              </dd>
              @if (teamName(w.ownerTeamId); as t) {
                <dt class="text-muted-foreground">Team</dt>
                <dd>{{ t }}</dd>
              }
              @if (projectName(w.projectId); as p) {
                <dt class="text-muted-foreground">Project</dt>
                <dd class="truncate">{{ p }}</dd>
              }
              @if (w.targetDate) {
                <dt class="text-muted-foreground">Target</dt>
                <dd>{{ date(w.targetDate) }}</dd>
              }
              @if (criteria(w); as c) {
                <dt class="text-muted-foreground">Criteria</dt>
                <dd>{{ c }}</dd>
              }
              @if (issuesOf(w).length) {
                <dt class="text-muted-foreground">Issues</dt>
                <dd class="flex min-w-0 flex-col items-start gap-1">
                  @for (i of issuesOf(w).slice(0, 5); track i.id) {
                    <app-entity-chip type="issue" [ref]="i.id" />
                  }
                  @if (issuesOf(w).length > 5) {
                    <span class="text-muted-foreground text-xs">+{{ issuesOf(w).length - 5 }} more</span>
                  }
                </dd>
              }
            </dl>
            @if (w.objective) {
              <div class="mt-5 border-t pt-4 text-[13px]"><app-markdown [source]="w.objective" [link]="refs.linker()" /></div>
            }
          </div>
        } @else {
          <p class="text-muted-foreground p-4 text-[13px]">Move to a row with <app-kbd keys="j" /> or <app-kbd keys="k" /> to preview it.</p>
        }

        @if (issue() || workstream()) {
          <div class="flex h-11 shrink-0 items-center gap-1 border-t px-2">
            <button hlmBtn size="sm" class="h-7 gap-1.5" (click)="open()">
              <svg [lucideIcon]="openIcon" [size]="13"></svg>Open <app-kbd keys="enter" class="opacity-70" />
            </button>
            <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 font-normal" (click)="copyLink()">
              <svg [lucideIcon]="copyIcon" [size]="13"></svg>Copy link
            </button>
          </div>
        }
      </aside>
    }
  `,
})
export class PeekPanel {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly peek = inject(PeekStore);
  protected readonly refs = inject(EntityRefs);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);
  private readonly document = inject(DOCUMENT);

  protected readonly xIcon = LucideX;
  protected readonly openIcon = LucideExternalLink;
  protected readonly copyIcon = LucideCopy;

  /** The focused row, whichever kind of record it is. */
  protected readonly issue = computed<Issue | undefined>(() => {
    const id = this.ui.focusedRowId();
    return id ? this.store.issueById().get(id) : undefined;
  });
  protected readonly workstream = computed<Workstream | undefined>(() => {
    const id = this.ui.focusedRowId();
    return id ? this.store.workstreamById().get(id) : undefined;
  });
  private readonly hasTarget = computed(() => !!this.issue() || !!this.workstream());

  private readonly _keys = usePageShortcuts([
    {
      keys: 'space',
      label: 'Preview the focused row',
      group: 'Lists',
      when: () => (this.hasTarget() || this.peek.open()) && !this.ownsSpace(),
      run: () => this.peek.toggle(),
    },
    {
      keys: 'esc',
      label: 'Close preview',
      group: 'Lists',
      hidden: true,
      when: () => this.peek.open(),
      run: () => this.peek.close(),
    },
  ]);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.peek.close());
  }

  protected teamName(id: string | undefined | null): string | undefined {
    return id ? this.store.getTeam(id)?.name : undefined;
  }
  protected projectName(id: string | undefined | null): string | undefined {
    return id ? this.store.getProject(id)?.name : undefined;
  }
  protected labels(ids: readonly string[]) {
    const catalog = this.store.settings().labels;
    return ids.flatMap((id) => catalog.find((l) => l.id === id) ?? []);
  }
  protected date(iso: string): string {
    return shortDate(iso);
  }
  protected criteria(w: Workstream): string {
    const all = w.acceptanceCriteria;
    return all.length ? `${all.filter((c) => c.state === 'met').length} of ${all.length} met` : '';
  }
  protected issuesOf(w: Workstream): Issue[] {
    return this.store.issuesByWorkstream().get(w.id) ?? [];
  }

  protected open(): void {
    const slug = this.store.slug() ?? '';
    const i = this.issue();
    const w = this.workstream();
    if (i) void this.router.navigate(['/', slug, 'issues', i.key]);
    else if (w) void this.router.navigate(['/', slug, 'workstreams', w.key]);
  }

  protected copyLink(): void {
    const slug = this.store.slug() ?? '';
    const origin = globalThis.location?.origin ?? '';
    const i = this.issue();
    const w = this.workstream();
    if (i) void this.clipboard.copy(`${origin}/${slug}/issues/${i.key}`, 'Link copied');
    else if (w) void this.clipboard.copy(`${origin}/${slug}/workstreams/${w.key}`, 'Link copied');
  }

  private ownsSpace(): boolean {
    const el = this.document.activeElement;
    return el instanceof HTMLElement && el.matches(OWNS_SPACE);
  }
}
