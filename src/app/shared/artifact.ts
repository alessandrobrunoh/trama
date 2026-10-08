import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  LucideBox,
  LucideCloud,
  LucideDynamicIcon,
  LucideFileText,
  LucideFlaskConical,
  LucideImage,
  LucidePaperclip,
  LucideGitBranch,
  LucideGitCommitHorizontal,
  LucideGitMerge,
  LucideGitPullRequest,
  LucideGitPullRequestDraft,
  LucideHammer,
  LucidePalette,
  LucideRocket,
  LucideTriangleAlert,
  type LucideIcon,
} from '@lucide/angular';
import type { ArtifactKind, ArtifactState, CiState, ReviewState } from '../core/contracts/domain';
import { StatusBadge } from './status';

const KIND_ICON: Record<ArtifactKind, LucideIcon> = {
  pull_request: LucideGitPullRequest,
  merge_request: LucideGitMerge,
  commit: LucideGitCommitHorizontal,
  branch: LucideGitBranch,
  document: LucideFileText,
  design: LucidePalette,
  image: LucideImage,
  file: LucidePaperclip,
  build: LucideHammer,
  test_report: LucideFlaskConical,
  deployment: LucideCloud,
  release: LucideRocket,
};

/** Kind glyph for an artifact (PR, MR, branch, deployment…), tinted by its state. */
@Component({
  selector: 'app-artifact-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'inline-flex shrink-0', '[class]': 'color()' },
  template: `<svg [lucideIcon]="icon()" [size]="size()" [strokeWidth]="1.75"></svg>`,
})
export class ArtifactIcon {
  readonly kind = input.required<ArtifactKind>();
  readonly state = input<ArtifactState>();
  readonly size = input(14);

  protected readonly icon = computed(() =>
    this.kind() === 'pull_request' && this.state() === 'draft'
      ? LucideGitPullRequestDraft
      : (KIND_ICON[this.kind()] ?? LucideBox),
  );
  protected readonly color = computed(() => {
    switch (this.state()) {
      case 'merged':
      case 'published':
        return 'text-status-in-review';
      case 'open':
      case 'running':
        return 'text-status-working';
      case 'failed':
        return 'text-status-blocked';
      case 'healthy':
      case 'succeeded':
        return 'text-status-shipped';
      default:
        return 'text-muted-foreground';
    }
  });
}

/** CI chip for a PR/MR: passing / failing / pending. */
@Component({
  selector: 'app-ci-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusBadge],
  template: `<app-status-badge [status]="ci()" [label]="'CI ' + ci()" />`,
})
export class CiChip {
  readonly ci = input.required<CiState>();
}

const REVIEW: Record<ReviewState, { label: string; tone: 'pending' | 'passing' | 'failing' } | null> = {
  none: null,
  requested: { label: 'Review requested', tone: 'pending' },
  approved: { label: 'Approved', tone: 'passing' },
  changes_requested: { label: 'Changes requested', tone: 'failing' },
};

/** Review chip for a PR/MR (renders nothing for `none`). */
@Component({
  selector: 'app-review-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusBadge],
  template: `
    @if (v(); as v) {
      <app-status-badge [status]="v.tone" [label]="v.label" />
    }
  `,
})
export class ReviewChip {
  readonly review = input.required<ReviewState>();
  protected readonly v = computed(() => REVIEW[this.review()]);
}

/** "Conflicts" warning chip for a PR/MR with merge conflicts. */
@Component({
  selector: 'app-conflict-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class:
      'bg-status-blocked/10 border-status-blocked/25 text-status-blocked inline-flex h-5 w-fit items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap',
  },
  template: `<svg [lucideIcon]="icon" [size]="12" [strokeWidth]="1.75"></svg>Conflicts`,
})
export class ConflictChip {
  protected readonly icon = LucideTriangleAlert;
}
