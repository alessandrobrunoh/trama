import {
  LucideBuilding2,
  LucideCircleCheck,
  LucideCircleX,
  LucideStar,
  LucideGitPullRequest,
  LucideMessageCircleQuestion,
  LucideMessageSquare,
  LucideScale,
  LucideUserRoundCheck,
  type LucideIcon,
} from '@lucide/angular';
import type { NotificationRecordKind } from '../../core/contracts/domain';

/** Icon and tint of each notification kind, shared by the inbox and the settings. */
export const NOTIFICATION_KIND_VISUAL: Record<
  NotificationRecordKind,
  { icon: LucideIcon; tint: string }
> = {
  assigned: { icon: LucideUserRoundCheck, tint: 'bg-primary/12 text-primary' },
  input_requested: { icon: LucideMessageCircleQuestion, tint: 'bg-tone-amber/12 text-tone-amber' },
  decision_proposed: { icon: LucideScale, tint: 'bg-entity-decision/12 text-entity-decision' },
  review_requested: { icon: LucideGitPullRequest, tint: 'bg-tone-blue/12 text-tone-blue' },
  ci_failed: { icon: LucideCircleX, tint: 'bg-tone-red/12 text-tone-red' },
  comment: { icon: LucideMessageSquare, tint: 'bg-muted text-muted-foreground' },
  workstream_update: { icon: LucideMessageSquare, tint: 'bg-muted text-muted-foreground' },
  customer_request: { icon: LucideBuilding2, tint: 'bg-tone-blue/12 text-tone-blue' },
  customer_important: { icon: LucideStar, tint: 'bg-tone-amber/12 text-tone-amber' },
  customer_delivered: { icon: LucideCircleCheck, tint: 'bg-tone-green/12 text-tone-green' },
};
