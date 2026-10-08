// Options + glyphs for the issue property popovers and the "Change status…" command dialog.
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LucideCircleDashed, LucideCircleUserRound, LucideDynamicIcon } from '@lucide/angular';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  PRIORITIES,
  PRIORITY_META,
  type Issue,
  type IssueStatus,
  type NablaStore,
  type Priority,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon, type AnyStatus } from '../../shared/status';
import type { IssueActions, IssuePromptField } from './issue-actions';
import { isOpenWorkstream } from './issue-model';

export interface IssueOption {
  /** '' = none (unassign, no team). */
  value: string;
  label: string;
  glyph: 'status' | 'priority' | 'user' | 'team' | 'workstream' | 'issue' | 'none';
  status?: string;
  hint?: string;
  search: string;
}

export const PROMPT_TITLE: Record<IssuePromptField, string> = {
  status: 'Change status…',
  priority: 'Set priority…',
  assignee: 'Assign to…',
  team: 'Move to team…',
  workstream: 'Add to workstream…',
  duplicate: 'Mark as duplicate of…',
};

export function promptOptions(store: NablaStore, field: IssuePromptField, issues: readonly Issue[]): IssueOption[] {
  switch (field) {
    case 'status':
      return ISSUE_STATUSES.map((s) => ({ value: s, label: ISSUE_STATUS_META[s].label, glyph: 'status', status: s, search: ISSUE_STATUS_META[s].label }));
    case 'priority':
      return PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label, glyph: 'priority', search: PRIORITY_META[p].label }));
    case 'assignee': {
      const me = store.me()?.id;
      const users = [...store.users()].sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name));
      return [
        { value: '', label: 'No assignee', glyph: 'none', search: 'no assignee unassign' },
        ...users.map((u) => ({
          value: u.id,
          label: u.id === me ? `${u.name} (you)` : u.name,
          glyph: 'user' as const,
          search: `${u.name} ${u.email}${u.id === me ? ' me' : ''}`,
        })),
      ];
    }
    case 'team':
      return [
        { value: '', label: 'No team', glyph: 'none', search: 'no team' },
        ...store.teams().map((t) => ({ value: t.id, label: t.name, glyph: 'team' as const, hint: t.key, search: `${t.name} ${t.key}` })),
      ];
    case 'workstream': {
      const linked = new Set(issues.flatMap((i) => i.workstreamIds));
      return store
        .workstreams()
        .filter((w) => isOpenWorkstream(w) || linked.has(w.id))
        .slice()
        .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((w) => ({ value: w.id, label: w.title, glyph: 'workstream', status: w.status, hint: w.key, search: `${w.key} ${w.title}` }));
    }
    case 'duplicate': {
      const self = new Set(issues.map((i) => i.id));
      return store
        .issues()
        .filter((i) => !self.has(i.id) && !i.duplicateOfId)
        .slice()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((i) => ({ value: i.id, label: i.title, glyph: 'issue', status: i.status, hint: i.key, search: `${i.key} ${i.title}` }));
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
      case 'team':
        return [i.teamId ?? ''];
      case 'workstream':
        return i.workstreamIds;
      case 'duplicate':
        return i.duplicateOfId ? [i.duplicateOfId] : [];
    }
  };
  const [first, ...rest] = issues.map(pick);
  return new Set(first.filter((v) => rest.every((r) => r.includes(v))));
}

/** Apply the chosen option. Returns true when the dialog / popover should close. */
export function applyOption(actions: IssueActions, field: IssuePromptField, ids: readonly string[], value: string): boolean {
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
    case 'team':
      actions.setTeam(ids, value || null);
      return true;
    case 'workstream':
      actions.toggleWorkstream(ids, value);
      return true;
    case 'duplicate':
      if (ids.length === 1) actions.markDuplicate(ids[0], value);
      return true;
  }
}

/** Leading glyph of an IssueOption. */
@Component({
  selector: 'app-issue-option-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, PriorityIcon, ActorAvatar, LucideDynamicIcon],
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
      @case ('workstream') {
        <app-status-icon [status]="asStatus(o.status)" entity="workstream" />
      }
      @case ('priority') {
        <app-priority-icon [priority]="asPriority(o.value)" />
      }
      @case ('user') {
        <app-actor-avatar [actor]="{ type: 'user', id: o.value }" [size]="16" />
      }
      @case ('team') {
        <app-actor-avatar [actor]="{ type: 'team', id: o.value }" [size]="16" />
      }
      @default {
        <svg [lucideIcon]="o.search.startsWith('no assignee') ? userIcon : noneIcon" [size]="15" class="text-muted-foreground"></svg>
      }
    }
  `,
})
export class IssueOptionGlyph {
  readonly option = input.required<IssueOption>();
  protected readonly userIcon = LucideCircleUserRound;
  protected readonly noneIcon = LucideCircleDashed;
  protected asStatus = (v: string | undefined) => (v ?? 'backlog') as AnyStatus;
  protected asPriority = (v: string) => v as Priority;
}
