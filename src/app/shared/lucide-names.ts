import { Injectable, signal } from '@angular/core';
import {
  LucideBan,
  LucideCircle,
  LucideCircleAlert,
  LucideCircleArrowUp,
  LucideCircleCheck,
  LucideCircleDashed,
  LucideCircleDot,
  LucideCircleEllipsis,
  LucideCircleHelp,
  LucideCircleMinus,
  LucideCirclePause,
  LucideCircleX,
  LucideGitMerge,
  LucideGitPullRequest,
  LucideRocket,
  LucideTag,
  LucideTriangleAlert,
  type LucideIcon,
} from '@lucide/angular';

/** Icons the status seeds use, available before the larger project set loads. */
export const STATUS_LUCIDE: ReadonlyMap<string, LucideIcon> = new Map<string, LucideIcon>([
  ['ban', LucideBan],
  ['circle', LucideCircle],
  ['circle-alert', LucideCircleAlert],
  ['circle-arrow-up', LucideCircleArrowUp],
  ['circle-check', LucideCircleCheck],
  ['circle-dashed', LucideCircleDashed],
  ['circle-dot', LucideCircleDot],
  ['circle-ellipsis', LucideCircleEllipsis],
  ['circle-help', LucideCircleHelp],
  ['circle-minus', LucideCircleMinus],
  ['circle-pause', LucideCirclePause],
  ['circle-x', LucideCircleX],
  ['git-merge', LucideGitMerge],
  ['git-pull-request', LucideGitPullRequest],
  ['rocket', LucideRocket],
  ['tag', LucideTag],
  ['triangle-alert', LucideTriangleAlert],
]);

const LUCIDE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isLucideName(value: string): boolean {
  return LUCIDE_NAME.test(value);
}

/** Resolves a lucide kebab-case name. Project icons load once, after the first ask. */
@Injectable({ providedIn: 'root' })
export class LucideNames {
  private readonly extra = signal<ReadonlyMap<string, LucideIcon>>(new Map());
  private loading = false;

  icon(name: string): LucideIcon {
    this.ensureExtra();
    return STATUS_LUCIDE.get(name) ?? this.extra().get(name) ?? LucideCircle;
  }

  private ensureExtra(): void {
    if (this.loading || this.extra().size) return;
    this.loading = true;
    void import('../features/projects/project-icons').then((mod) => this.extra.set(mod.ICON_BY_NAME));
  }
}
