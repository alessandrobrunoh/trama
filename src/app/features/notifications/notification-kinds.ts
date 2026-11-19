import {
  LucideCircleX,
  LucideGitPullRequest,
  LucideMessageSquare,
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
  review_requested: { icon: LucideGitPullRequest, tint: 'bg-tone-blue/12 text-tone-blue' },
  ci_failed: { icon: LucideCircleX, tint: 'bg-tone-red/12 text-tone-red' },
  comment: { icon: LucideMessageSquare, tint: 'bg-muted text-muted-foreground' },
  workstream_update: { icon: LucideMessageSquare, tint: 'bg-muted text-muted-foreground' },
};
