import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import {
  LucideCircle,
  LucideCircleAlert,
  LucideCircleArrowUp,
  LucideCircleCheck,
  LucideCircleDashed,
  LucideCircleHelp,
  LucideCircleMinus,
  LucideCircleX,
  LucideGitMerge,
  LucideRocket,
  type LucideIcon,
} from '@lucide/angular';
import { LucideDynamicIcon } from '@lucide/angular';
import type {
  ArtifactState,
  CiState,
  DecisionStatus,
  IssueStatus,
  WorkstreamStatus,
} from '../core/contracts/domain';

/** Every enum value that has a status visual. */
export type AnyStatus =
  | WorkstreamStatus
  | IssueStatus
  | DecisionStatus
  | ArtifactState
  | CiState;

type Glyph =
  | { kind: 'icon'; icon: LucideIcon }
  /** Pie: 0..1 filled fraction. */
  | { kind: 'pie'; fraction: number }
  | { kind: 'dashed' };

interface StatusVisual {
  label: string;
  /** Tailwind text color class (token-backed, dark-mode safe). */
  text: string;
  /** Tailwind classes for a tinted pill background + border. */
  pill: string;
  glyph: Glyph;
}

/* Tone → static class strings (Tailwind must see the full class names). */
const TONE = {
  neutral: { text: 'text-status-draft', pill: 'bg-status-draft/10 border-status-draft/25' },
  planned: { text: 'text-status-planned', pill: 'bg-status-planned/10 border-status-planned/25' },
  active: { text: 'text-status-working', pill: 'bg-status-working/10 border-status-working/25' },
  input: { text: 'text-status-needs-input', pill: 'bg-status-needs-input/10 border-status-needs-input/25' },
  review: { text: 'text-status-in-review', pill: 'bg-status-in-review/10 border-status-in-review/25' },
  danger: { text: 'text-status-blocked', pill: 'bg-status-blocked/10 border-status-blocked/25' },
  ready: { text: 'text-status-ready-to-land', pill: 'bg-status-ready-to-land/10 border-status-ready-to-land/25' },
  done: { text: 'text-status-shipped', pill: 'bg-status-shipped/10 border-status-shipped/25' },
} as const;

const v = (label: string, tone: keyof typeof TONE, glyph: Glyph): StatusVisual => ({
  label,
  ...TONE[tone],
  glyph,
});
const icon = (i: LucideIcon): Glyph => ({ kind: 'icon', icon: i });

export const STATUS_VISUALS: Record<AnyStatus, StatusVisual> = {
  // WorkstreamStatus
  draft: v('Draft', 'neutral', { kind: 'dashed' }),
  planned: v('Planned', 'planned', icon(LucideCircle)),
  working: v('Working', 'active', { kind: 'pie', fraction: 0.5 }),
  needs_input: v('Needs input', 'input', icon(LucideCircleHelp)),
  in_review: v('In review', 'review', { kind: 'pie', fraction: 0.75 }),
  blocked: v('Blocked', 'danger', icon(LucideCircleMinus)),
  ready_to_land: v('Ready to land', 'ready', icon(LucideCircleArrowUp)),
  shipped: v('Shipped', 'done', icon(LucideCircleCheck)),
  canceled: v('Canceled', 'neutral', icon(LucideCircleX)),
  // IssueStatus (in_review and canceled are shared with workstreams)
  backlog: v('Backlog', 'neutral', { kind: 'dashed' }),
  todo: v('Todo', 'planned', icon(LucideCircle)),
  in_progress: v('In progress', 'active', { kind: 'pie', fraction: 0.5 }),
  done: v('Done', 'done', icon(LucideCircleCheck)),
  // DecisionStatus
  accepted: v('Accepted', 'done', icon(LucideCircleCheck)),
  proposed: v('Proposed', 'input', { kind: 'dashed' }),
  superseded: v('Superseded', 'neutral', icon(LucideCircleMinus)),
  rejected: v('Rejected', 'danger', icon(LucideCircleX)),
  // ArtifactState / CI
  open: v('Open', 'active', icon(LucideCircle)),
  merged: v('Merged', 'review', icon(LucideGitMerge)),
  closed: v('Closed', 'neutral', icon(LucideCircleX)),
  pending: v('Pending', 'input', { kind: 'dashed' }),
  running: v('Running', 'active', { kind: 'pie', fraction: 0.5 }),
  failed: v('Failed', 'danger', icon(LucideCircleX)),
  succeeded: v('Succeeded', 'done', icon(LucideCircleCheck)),
  healthy: v('Healthy', 'done', icon(LucideCircleCheck)),
  degraded: v('Degraded', 'input', icon(LucideCircleAlert)),
  published: v('Published', 'done', icon(LucideRocket)),
  passing: v('Passing', 'done', icon(LucideCircleCheck)),
  failing: v('Failing', 'danger', icon(LucideCircleX)),
};

export function statusLabel(status: AnyStatus): string {
  return STATUS_VISUALS[status].label;
}

/**
 * Status glyph (14px by default): draft = dashed ring, working = half pie,
 * in_review = three-quarter pie, shipped = check, … Color comes from the status token.
 *   <app-status-icon status="working" />   <app-status-icon [status]="ws.status" [size]="16" />
 */
@Component({
  selector: 'app-status-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class: 'inline-flex shrink-0 items-center justify-center',
    '[class]': 'visual().text',
    '[attr.role]': '"img"',
    '[attr.aria-label]': 'visual().label',
  },
  template: `
    @let g = visual().glyph;
    @switch (g.kind) {
      @case ('icon') {
        <svg [lucideIcon]="g.icon" [size]="size()" [strokeWidth]="1.75"></svg>
      }
      @case ('dashed') {
        <svg [lucideIcon]="dashed" [size]="size()" [strokeWidth]="1.75"></svg>
      }
      @case ('pie') {
        <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" />
          <path [attr.d]="piePath(g.fraction)" fill="currentColor" />
        </svg>
      }
    }
  `,
})
export class StatusIcon {
  readonly status = input.required<AnyStatus>();
  readonly size = input(14);

  protected readonly dashed = LucideCircleDashed;
  protected readonly visual = computed(() => STATUS_VISUALS[this.status()]);

  protected piePath(f: number): string {
    // pie of radius 3.5 starting at 12 o'clock going clockwise
    const r = 3.5;
    const a = f * 2 * Math.PI;
    const x = 8 + r * Math.sin(a);
    const y = 8 - r * Math.cos(a);
    const large = f > 0.5 ? 1 : 0;
    return `M8 8 L8 ${8 - r} A${r} ${r} 0 ${large} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
  }
}

/**
 * Tinted pill: icon + label. Use `[iconOnly]` for dense tables, `size="sm"` for rows.
 *   <app-status-badge [status]="ws.status" />
 */
@Component({
  selector: 'app-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon],
  host: {
    class:
      'inline-flex h-5 w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-xs font-medium',
    '[class]': 'visual().pill + " " + visual().text',
  },
  template: `
    <app-status-icon [status]="status()" [size]="12" />
    @if (!iconOnly()) {
      <span>{{ label() ?? visual().label }}</span>
    }
  `,
})
export class StatusBadge {
  readonly status = input.required<AnyStatus>();
  /** Override the default label (e.g. "Open · 2"). */
  readonly label = input<string>();
  readonly iconOnly = input(false, { transform: booleanAttribute });

  protected readonly visual = computed(() => STATUS_VISUALS[this.status()]);
}

/** Icon + plain text (no pill) — for lists, property rows and menus. */
@Component({
  selector: 'app-status-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon],
  host: { class: 'inline-flex items-center gap-1.5 whitespace-nowrap' },
  template: `
    <app-status-icon [status]="status()" />
    <span>{{ label() ?? visual().label }}</span>
  `,
})
export class StatusLabel {
  readonly status = input.required<AnyStatus>();
  readonly label = input<string>();
  protected readonly visual = computed(() => STATUS_VISUALS[this.status()]);
}
