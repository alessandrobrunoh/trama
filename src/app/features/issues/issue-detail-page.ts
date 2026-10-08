import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideEllipsis, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  ISSUE_KIND_META,
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  NablaStore,
  UiStore,
  type IssueStatus,
  type Priority,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { IssueKindLabel } from '../../shared/issue';
import { KeyChip } from '../../shared/key-chip';
import { PropertyRow } from '../../shared/property-row';
import { CommentThread } from '../workstreams/comments';
import { EditableMarkdown, InlineText } from '../workstreams/inline-edit';
import { Picker, type PickOption } from '../workstreams/picker';
import { priorityOptions, teamOptions, userOptions } from '../workstreams/ws-model';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual',
  github: 'GitHub',
  gitlab: 'GitLab',
  email: 'Email',
  api: 'API',
  agent: 'Agent',
};

@Component({
  selector: 'app-issue-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TopBarActions,
    EmptyState,
    IssueKindLabel,
    KeyChip,
    PropertyRow,
    Picker,
    InlineText,
    EditableMarkdown,
    CommentThread,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (issue(); as i) {
      <ng-template appTopBarActions>
        @if (canEdit()) {
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="Issue actions">
            <svg [lucideIcon]="moreIcon" [size]="16"></svg>
          </button>
          <ng-template #more>
            <hlm-dropdown-menu class="w-44">
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete issue
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        }
      </ng-template>

      <header class="border-b px-4 pt-3 sm:px-6">
        <div class="flex items-center gap-2">
          <app-issue-kind [kind]="i.kind" />
          <app-key-chip [value]="i.key" class="text-sm" />
          <app-inline-text
            class="min-w-0 flex-1"
            label="title"
            textClass="text-lg font-semibold tracking-tight"
            [value]="i.title"
            [canEdit]="canEdit()"
            (save)="store.updateIssue(i.id, { title: $event })"
          />
        </div>
        <p class="text-muted-foreground pb-3 text-xs">{{ kindLabel() }} · {{ sourceLabel() }}</p>
      </header>

      <div class="grid gap-x-8 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="flex min-w-0 flex-col gap-8">
          <section>
            <h2 class="mb-1 text-sm font-semibold">Description</h2>
            <app-editable-markdown
              label="description"
              placeholder="Click to describe the problem, request, or task…"
              [value]="i.body ?? ''"
              [canEdit]="canEdit()"
              (save)="store.updateIssue(i.id, { body: $event || null })"
            />
          </section>

          <section>
            <h2 class="mb-2 text-sm font-semibold">Workstreams</h2>
            @if (workstreams().length) {
              <ul class="flex flex-col overflow-hidden rounded-lg border">
                @for (w of workstreams(); track w.id) {
                  <li>
                    <a [routerLink]="['/', slug(), 'workstreams', w.key]" class="hover:bg-muted/50 flex min-h-9 items-center gap-2.5 border-b px-3 text-sm last:border-b-0">
                      <app-key-chip [value]="w.key" class="w-16" />
                      <span class="min-w-0 flex-1 truncate">{{ w.title }}</span>
                    </a>
                  </li>
                }
              </ul>
            } @else {
              <p class="text-muted-foreground text-sm">Not linked to a workstream yet.</p>
            }
          </section>

          @if (duplicate(); as dup) {
            <p class="text-muted-foreground text-sm">
              Duplicate of
              <a class="text-primary hover:underline" [routerLink]="['/', slug(), 'issues', dup.key]">{{ dup.key }}</a>
              {{ dup.title }}
            </p>
          }

          <section>
            <h2 class="mb-3 text-sm font-semibold">Comments</h2>
            <app-comment-thread [subject]="{ type: 'issue', id: i.id }" />
          </section>
        </div>

        <aside class="lg:border-l lg:pl-6" aria-label="Properties">
          <h2 class="mb-1 text-sm font-semibold">Properties</h2>
          <div class="flex flex-col gap-0.5">
            <app-property-row label="Status">
              <app-picker variant="field" label="Status" [searchable]="false" [disabled]="!canEdit()" [options]="statuses" [value]="[i.status]" (valueChange)="setStatus(i.id, $event[0])" />
            </app-property-row>
            <app-property-row label="Priority">
              <app-picker variant="field" label="Priority" [searchable]="false" [disabled]="!canEdit()" [options]="priorities" [value]="[i.priority]" (valueChange)="setPriority(i.id, $event[0])" />
            </app-property-row>
            <app-property-row label="Assignee">
              <app-picker variant="field" label="Assignee" placeholder="Unassigned" [clearable]="true" clearLabel="Unassign" [disabled]="!canEdit()" [options]="users()" [value]="i.assigneeId ? [i.assigneeId] : []" (valueChange)="store.updateIssue(i.id, { assigneeId: $event[0] ?? null })" />
            </app-property-row>
            <app-property-row label="Team">
              <app-picker variant="field" label="Team" placeholder="No team" [clearable]="true" clearLabel="No team" [disabled]="!canEdit()" [options]="teams()" [value]="i.teamId ? [i.teamId] : []" (valueChange)="store.updateIssue(i.id, { teamId: $event[0] ?? null })" />
            </app-property-row>
            <app-property-row label="Type">
              <span class="inline-flex items-center gap-1.5 px-1.5 text-sm"><app-issue-kind [kind]="i.kind" showLabel /></span>
            </app-property-row>
          </div>
          @if (i.externalUrl) {
            <a class="text-primary mt-3 block truncate text-xs hover:underline" [href]="i.externalUrl" target="_blank" rel="noopener noreferrer">{{ i.externalUrl }}</a>
          }
        </aside>
      </div>
    } @else {
      <app-empty-state title="Issue not found" description="It may have been deleted, or the id is wrong.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'issues']">Back to issues</a>
      </app-empty-state>
    }
  `,
})
export class IssueDetailPage {
  private readonly router = inject(Router);
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Route param: issue key (`BUG-142`) or id. */
  readonly key = input<string>();

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly issue = computed(() => this.store.getIssue(this.key()));
  protected readonly workstreams = computed(() =>
    (this.issue()?.workstreamIds ?? []).flatMap((id) => {
      const w = this.store.workstreamById().get(id);
      return w ? [w] : [];
    }),
  );
  protected readonly duplicate = computed(() => {
    const id = this.issue()?.duplicateOfId;
    return id ? this.store.issueById().get(id) : undefined;
  });
  protected readonly kindLabel = computed(() => {
    const kind = this.issue()?.kind;
    return kind ? ISSUE_KIND_META[kind].label : '';
  });
  protected readonly sourceLabel = computed(() => SOURCE_LABEL[this.issue()?.source ?? ''] ?? '');

  protected readonly statuses: PickOption[] = ISSUE_STATUSES.map((s) => ({
    value: s,
    label: ISSUE_STATUS_META[s].label,
    kind: 'status',
  }));
  protected readonly priorities = priorityOptions();
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Issues', link: ['/', this.slug(), 'issues'] },
    { label: this.issue()?.key ?? this.key() ?? '', mono: true },
  ]);

  protected setStatus(id: string, value: string | undefined): void {
    if (!value || !ISSUE_STATUSES.includes(value as IssueStatus)) return;
    void this.store.updateIssue(id, { status: value as IssueStatus });
  }

  protected setPriority(id: string, value: string | undefined): void {
    if (!value) return;
    void this.store.updateIssue(id, { priority: value as Priority });
  }

  protected remove(): void {
    const issue = this.issue();
    if (!issue) return;
    this.ui.setConfirmDelete({
      title: `Delete ${issue.key}?`,
      description: 'Comments on this issue are deleted too. This cannot be undone.',
      onConfirm: async () => {
        const ok = await this.store.deleteIssue(issue.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'issues']);
      },
    });
  }
}
