import {
  LucideCircleX,
  LucideGitPullRequest,
  LucideHexagon,
  LucideMessageCircleQuestion,
  LucideMessageSquare,
  LucideScale,
  LucideUserRoundCheck,
  type LucideIcon,
} from '@lucide/angular';
import type { NotificationKind } from '../../core/contracts/domain';

/** Icon and tint of each notification kind, shared by the inbox and the settings. */
export const NOTIFICATION_KIND_VISUAL: Record<NotificationKind, { icon: LucideIcon; tint: string }> = {
  assigned: { icon: LucideUserRoundCheck, tint: 'bg-primary/12 text-primary' },
  input_requested: { icon: LucideMessageCircleQuestion, tint: 'bg-tone-amber/12 text-tone-amber' },
  decision_proposed: { icon: LucideScale, tint: 'bg-entity-decision/12 text-entity-decision' },
  review_requested: { icon: LucideGitPullRequest, tint: 'bg-tone-blue/12 text-tone-blue' },
  ci_failed: { icon: LucideCircleX, tint: 'bg-tone-red/12 text-tone-red' },
  comment: { icon: LucideMessageSquare, tint: 'bg-muted text-muted-foreground' },
  workstream_update: { icon: LucideHexagon, tint: 'bg-entity-workstream/12 text-entity-workstream' },
};
