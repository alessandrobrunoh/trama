// Options + glyphs for the issue property popovers and the "Change status…" command dialog.
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import {
  LucideBox,
  LucideCircleDashed,
  LucideCircleUserRound,
  LucideDynamicIcon,
} from '@lucide/angular';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  estimateFraction,
  estimateOptions,
  formatEstimateLong,
  PRIORITIES,
  PRIORITY_META,
  type Issue,
  type IssueStatus,
  type TramaStore,
  type Priority,
  type WorkspaceLabel,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EstimateGlyph } from '../../shared/estimate';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon, type AnyStatus } from '../../shared/status';
import type { IssueActions, IssuePromptField } from './issue-actions';
import { isClosedIssue } from './issue-model';

export interface IssueOption {
  /** '' = none (unassign, no project). */
  value: string;
  label: string;
  glyph: 'status' | 'priority' | 'user' | 'issue' | 'project' | 'label' | 'estimate' | 'none';
  /** Swatch of a label. */
  color?: string;
  /** 0..1 position on the estimate scale (glyph `estimate`). */
  fraction?: number;
  status?: string;
  hint?: string;
  search: string;
}

export const PROMPT_TITLE: Record<IssuePromptField, string> = {
  status: 'Change status…',
  priority: 'Set priority…',
  assignee: 'Assign to…',
  project: 'Move to project…',
  label: 'Toggle label…',
  duplicate: 'Mark as duplicate of…',
  estimate: 'Set estimate…',
};

/** `labels` is the already ordered label list (see `LabelCatalog.arrange`); without it the catalog order is used. */
export function promptOptions(
  store: TramaStore,
  field: IssuePromptField,
  issues: readonly Issue[],
  labels?: readonly WorkspaceLabel[],
): IssueOption[] {
  switch (field) {
    case 'status':
      return store.settings().statuses.issue.map((s) => ({ value: s.id, label: s.name, glyph: 'status' as const, status: s.id, search: s.name }));
    case 'priority':
      return PRIORITIES.map((p) => ({
        value: p,
        label: PRIORITY_META[p].label,
        glyph: 'priority',
        search: PRIORITY_META[p].label,
      }));
    case 'assignee': {
      const me = store.me()?.id;
      const users = [...store.users()].sort(
        (a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name),
      );
      const entries = store.settings().statuses.issue;
      const open = new Map<string, number>();
      for (const i of store.issues()) {
        if (i.assigneeId && !isClosedIssue(i, entries)) {
          open.set(i.assigneeId, (open.get(i.assigneeId) ?? 0) + 1);
        }
      }
      return [
        { value: '', label: 'Unassign', glyph: 'none', search: 'no assignee unassign' },
        ...users.map((u) => ({
          value: u.id,
          label: u.id === me ? `${u.name} (you)` : u.name,
          glyph: 'user' as const,
          hint: `${open.get(u.id) ?? 0} open`,
          search: `${u.name} ${u.email}${u.id === me ? ' me' : ''}`,
        })),
      ];
    }
    case 'project':
      return [
        { value: '', label: 'No project', glyph: 'none', search: 'no project' },
        ...store
          .projects()
          .map((p) => ({ value: p.id, label: p.name, glyph: 'project' as const, search: p.name })),
      ];
    case 'label':
      return (
        labels ?? store.settings().labels.filter((l) => !l.archived && l.scope === 'issue')
      ).map((l) => ({
        value: l.id,
        label: l.name,
        glyph: 'label' as const,
        color: l.color,
        search: l.name,
      }));
    case 'estimate': {
      const scale = store.estimateScale();
      const opts: IssueOption[] = estimateOptions(scale).map((o) => ({
        value: String(o.value),
        label: formatEstimateLong(o.value, scale),
        glyph: 'estimate' as const,
        fraction: estimateFraction(o.value, scale),
        search: `${o.label} ${o.value}`,
      }));
      // A value outside the current scale stays selectable, so nothing is lost silently.
      for (const issue of issues) {
        const v = issue.estimate;
        if (v === undefined || v === null || opts.some((o) => o.value === String(v))) continue;
        opts.push({
          value: String(v),
          label: formatEstimateLong(v, scale),
          glyph: 'estimate',
          fraction: estimateFraction(v, scale),
          search: String(v),
        });
      }
      return [{ value: '', label: 'No estimate', glyph: 'none', search: 'no estimate none clear' }, ...opts];
    }
    case 'duplicate': {
      const self = new Set(issues.map((i) => i.id));
      return store
        .issues()
        .filter((i) => !self.has(i.id) && !i.duplicateOfId)
        .slice()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((i) => ({
          value: i.id,
          label: i.title,
          glyph: 'issue',
          status: i.status,
          hint: i.key,
          search: `${i.key} ${i.title}`,
        }));
    }
  }
}

/** Values every one of `issues` currently has (checkmarks in the list). */
export function currentValues(field: IssuePromptField, issues: readonly Issue[]): Set<string> {
  if (!issues.length) return new Set();
  const pick = (i: Issue): string[] => {
    switch (field) {
      case 'status':
        return [i.status];
      case 'priority':
        return [i.priority];
      case 'assignee':
        return [i.assigneeId ?? ''];
      case 'project':
        return [i.projectId ?? ''];
      case 'label':
        return i.labels;
      case 'duplicate':
        return i.duplicateOfId ? [i.duplicateOfId] : [];
      case 'estimate':
        return [i.estimate === undefined || i.estimate === null ? '' : String(i.estimate)];
    }
  };
  const [first, ...rest] = issues.map(pick);
  return new Set(first.filter((v) => rest.every((r) => r.includes(v))));
}

/** Apply the chosen option. Returns true when the dialog / popover should close. */
export function applyOption(
  actions: IssueActions,
  field: IssuePromptField,
  ids: readonly string[],
  value: string,
): boolean {
  switch (field) {
    case 'status':
      actions.setStatus(ids, value as IssueStatus);
      return true;
    case 'priority':
      actions.setPriority(ids, value as Priority);
      return true;
    case 'assignee':
      actions.setAssignee(ids, value || null);
      return true;
    case 'project':
      actions.setProject(ids, value || null);
      return true;
    case 'label':
      actions.toggleLabel(ids, value);
      // Labels are a multi-select: the list stays open to toggle more.
      return false;
    case 'duplicate':
      if (ids.length === 1) actions.markDuplicate(ids[0], value);
      return true;
    case 'estimate':
      actions.setEstimate(ids, value === '' ? null : Number(value));
      return true;
  }
}

/** Leading glyph of an IssueOption. */
@Component({
  selector: 'app-issue-option-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, PriorityIcon, ActorAvatar, LucideDynamicIcon, EstimateGlyph],
  host: { class: 'inline-flex size-4 shrink-0 items-center justify-center' },
  template: `
    @let o = option();
    @switch (o.glyph) {
      @case ('status') {
        <app-status-icon [status]="asStatus(o.status)" entity="issue" />
      }
      @case ('issue') {
        <app-status-icon [status]="asStatus(o.status)" entity="issue" />
      }
      @case ('priority') {
        <app-priority-icon [priority]="asPriority(o.value)" />
      }
      @case ('user') {
        <app-actor-avatar [actor]="{ type: 'user', id: o.value }" [size]="16" />
      }
      @case ('project') {
        <svg [lucideIcon]="projectIcon" [size]="15" class="text-muted-foreground"></svg>
      }
      @case ('label') {
        <span class="size-2.5 rounded-full" [style.background]="o.color"></span>
      }
      @case ('estimate') {
        <app-estimate-glyph class="text-muted-foreground" [fraction]="o.fraction ?? 0" [size]="14" />
      }
      @default {
        <svg
          [lucideIcon]="o.search.startsWith('no assignee') ? userIcon : noneIcon"
          [size]="15"
          class="text-muted-foreground"
        ></svg>
      }
    }
  `,
})
export class IssueOptionGlyph {
  readonly option = input.required<IssueOption>();
  protected readonly userIcon = LucideCircleUserRound;
  protected readonly noneIcon = LucideCircleDashed;
  protected readonly projectIcon = LucideBox;
  protected asStatus = (v: string | undefined) => (v ?? 'backlog') as AnyStatus;
  protected asPriority = (v: string) => v as Priority;
}
