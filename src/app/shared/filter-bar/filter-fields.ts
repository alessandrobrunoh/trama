// Presentation of the filterable properties: their icon in the property list and chips, and the plural a
// chip uses when several values are picked ("3 statuses").
import {
  LucideBox,
  LucideCalendar,
  LucideCalendarCheck,
  LucideCalendarClock,
  LucideCalendarPlus,
  LucideCircleDot,
  LucideFlag,
  LucideGauge,
  LucideGitBranch,
  LucideHash,
  LucideLink,
  LucideListFilter,
  LucideListTree,
  LucideShapes,
  LucideSignalHigh,
  LucideTag,
  LucideUserPen,
  LucideUserRound,
  type LucideIcon,
} from '@lucide/angular';

export const FIELD_ICON: Readonly<Record<string, LucideIcon>> = {
  status: LucideCircleDot,
  assigneeId: LucideUserRound,
  leadId: LucideUserRound,
  reporterId: LucideUserPen,
  priority: LucideSignalHigh,
  labels: LucideTag,
  projectId: LucideBox,
  milestoneIds: LucideFlag,
  kind: LucideShapes,
  estimate: LucideGauge,
  dueDate: LucideCalendarClock,
  targetDate: LucideCalendarClock,
  startDate: LucideCalendar,
  createdAt: LucideCalendarPlus,
  updatedAt: LucideCalendar,
  completedAt: LucideCalendarCheck,
  thread: LucideLink,
  source: LucideGitBranch,
  subtasks: LucideListTree,
  health: LucideSignalHigh,
  repository: LucideHash,
};

export const iconOfField = (field: string): LucideIcon => FIELD_ICON[field] ?? LucideListFilter;

/** What several values of a property are called ("3 statuses"). */
const FIELD_NOUN: Readonly<Record<string, string>> = {
  status: 'statuses',
  assigneeId: 'assignees',
  leadId: 'leads',
  reporterId: 'creators',
  priority: 'priorities',
  labels: 'labels',
  projectId: 'projects',
  milestoneIds: 'milestones',
  kind: 'types',
  thread: 'values',
  source: 'sources',
  health: 'values',
  estimate: 'values',
};

export const nounOfField = (field: string): string => FIELD_NOUN[field] ?? 'values';
