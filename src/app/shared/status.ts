import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';
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
export type AnyStatus = WorkstreamStatus | IssueStatus | DecisionStatus | ArtifactState | CiState;

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
  input: {
    text: 'text-status-needs-input',
    pill: 'bg-status-needs-input/10 border-status-needs-input/25',
  },
  review: {
    text: 'text-status-in-review',
    pill: 'bg-status-in-review/10 border-status-in-review/25',
  },
  danger: { text: 'text-status-blocked', pill: 'bg-status-blocked/10 border-status-blocked/25' },
  ready: {
    text: 'text-status-ready-to-land',
    pill: 'bg-status-ready-to-land/10 border-status-ready-to-land/25',
  },
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

/** Which glyph family to draw. Issues are circles (demand), workstreams hexagons (outcomes). */
export type StatusEntity = 'auto' | 'workstream' | 'issue' | 'other';

const WORKSTREAM_ONLY = new Set<string>([
  'draft',
  'planned',
  'working',
  'needs_input',
  'blocked',
  'ready_to_land',
  'shipped',
]);
const ISSUE_ONLY = new Set<string>(['backlog', 'todo', 'in_progress', 'done']);

type Shape = 'hex' | 'circle' | 'icon';

/** Workstream glyph (hexagon) details: fill fraction + inner mark. */
const HEX: Record<
  string,
  { fill: number; dashed?: boolean; mark?: 'check' | 'x' | 'q' | 'minus' | 'up'; solid?: boolean }
> = {
  draft: { fill: 0, dashed: true },
  planned: { fill: 0 },
  working: { fill: 0.5 },
  needs_input: { fill: 0, mark: 'q' },
  in_review: { fill: 0.75 },
  blocked: { fill: 1, mark: 'minus', solid: true },
  ready_to_land: { fill: 1, mark: 'up', solid: true },
  shipped: { fill: 1, mark: 'check', solid: true },
  canceled: { fill: 1, mark: 'x', solid: true },
};
/** Issue glyph (circle) details. */
const CIRCLE: Record<
  string,
  { fill: number; dashed?: boolean; mark?: 'check' | 'x'; solid?: boolean }
> = {
  draft: { fill: 0, dashed: true },
  backlog: { fill: 0, dashed: true },
  todo: { fill: 0 },
  in_progress: { fill: 0.5 },
  in_review: { fill: 0.75 },
  done: { fill: 1, mark: 'check', solid: true },
  canceled: { fill: 1, mark: 'x', solid: true },
};

const HEX_OUTER = '8,1.4 13.7,4.7 13.7,11.3 8,14.6 2.3,11.3 2.3,4.7';
const HEX_INNER = '8,4.3 11.2,6.15 11.2,9.85 8,11.7 4.8,9.85 4.8,6.15';

/**
 * Status glyph (14px by default). Two families keep the two core concepts apart at a glance:
 *   issues (demand)       → circles: dashed backlog, empty todo, half in progress, ¾ in review, ✓ done
 *   workstreams (outcome) → hexagons: dashed draft, empty planned, half working, ¾ in review, ✓ shipped
 * `in_review` / `canceled` exist in both — pass `entity` when the subject is ambiguous.
 *   <app-status-icon [status]="ws.status" entity="workstream" />
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
    @switch (shape()) {
      @case ('hex') {
        @let h = hex();
        <svg
          [attr.width]="size()"
          [attr.height]="size()"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          @if (h.solid) {
            <polygon
              [attr.points]="outer"
              fill="currentColor"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          } @else {
            <polygon
              [attr.points]="outer"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
              [attr.stroke-dasharray]="h.dashed ? '2 1.6' : null"
            />
            @if (h.fill > 0) {
              <clipPath [attr.id]="clipId">
                <rect
                  x="0"
                  [attr.y]="11.7 - 7.4 * h.fill"
                  width="16"
                  [attr.height]="7.4 * h.fill + 0.1"
                />
              </clipPath>
              <polygon
                [attr.points]="inner"
                fill="currentColor"
                [attr.clip-path]="'url(#' + clipId + ')'"
              />
            }
          }
          @switch (h.mark) {
            @case ('check') {
              <path
                d="M5.4 8.1 7.2 9.9 10.7 6.2"
                stroke="var(--background)"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            }
            @case ('x') {
              <path
                d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"
                stroke="var(--background)"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            }
            @case ('minus') {
              <path
                d="M5.3 8h5.4"
                stroke="var(--background)"
                stroke-width="1.7"
                stroke-linecap="round"
              />
            }
            @case ('up') {
              <path
                d="M8 10.6V5.6M5.8 7.7 8 5.5l2.2 2.2"
                stroke="var(--background)"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            }
            @case ('q') {
              <path
                d="M6.6 6.6a1.45 1.45 0 0 1 2.8.5c0 .95-1.4 1.2-1.4 2"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
              <circle cx="8" cy="10.9" r=".75" fill="currentColor" />
            }
          }
        </svg>
      }
      @case ('circle') {
        @let c = circle();
        <svg
          [attr.width]="size()"
          [attr.height]="size()"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          @if (c.solid) {
            <circle cx="8" cy="8" r="6.75" fill="currentColor" />
            @if (c.mark === 'check') {
              <path
                d="M5.3 8.2 7.1 10l3.6-3.8"
                stroke="var(--background)"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            } @else {
              <path
                d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"
                stroke="var(--background)"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            }
          } @else {
            <circle
              cx="8"
              cy="8"
              r="6.25"
              stroke="currentColor"
              stroke-width="1.5"
              [attr.stroke-dasharray]="c.dashed ? '2.2 1.9' : null"
            />
            @if (c.fill > 0) {
              <path [attr.d]="piePath(c.fill)" fill="currentColor" />
            }
          }
        </svg>
      }
      @default {
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
      }
    }
  `,
})
export class StatusIcon {
  readonly status = input.required<AnyStatus>();
  readonly size = input(14);
  /** Glyph family; `auto` infers it from the status value (shared values fall back to circles). */
  readonly entity = input<StatusEntity>('auto');

  private static seq = 0;
  protected readonly clipId = `hexclip-${++StatusIcon.seq}`;
  protected readonly outer = HEX_OUTER;
  protected readonly inner = HEX_INNER;
  protected readonly dashed = LucideCircleDashed;
  protected readonly visual = computed(() => STATUS_VISUALS[this.status()]);
  protected readonly shape = computed<Shape>(() => {
    const s = this.status();
    const e = this.entity();
    if (e === 'workstream' && HEX[s]) return 'hex';
    if (e === 'issue' && CIRCLE[s]) return 'circle';
    if (e === 'other') return 'icon';
    if (WORKSTREAM_ONLY.has(s)) return 'hex';
    if (ISSUE_ONLY.has(s) || (e === 'auto' && CIRCLE[s] && s !== 'canceled')) return 'circle';
    return 'icon';
  });
  protected readonly hex = computed(() => HEX[this.status()] ?? HEX['planned']);
  protected readonly circle = computed(() => CIRCLE[this.status()] ?? CIRCLE['todo']);

  protected piePath(f: number): string {
    // pie of radius 3.5 starting at 12 o'clock going clockwise
    const r = 3.5;
    if (f >= 1) return `M8 ${8 - r} A${r} ${r} 0 1 1 7.999 ${8 - r} Z`;
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
      'border-border-strong text-foreground/85 inline-flex h-5 w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-xs font-medium',
  },
  template: `
    <app-status-icon [status]="status()" [entity]="entity()" [size]="12" />
    @if (!iconOnly()) {
      <!-- the glyph carries the colour; text stays neutral (Linear-style chip) -->
      <span>{{ label() ?? visual().label }}</span>
    }
  `,
})
export class StatusBadge {
  readonly status = input.required<AnyStatus>();
  /** Override the default label (e.g. "Open · 2"). */
  readonly label = input<string>();
  readonly iconOnly = input(false, { transform: booleanAttribute });
  readonly entity = input<StatusEntity>('auto');

  protected readonly visual = computed(() => STATUS_VISUALS[this.status()]);
}

/** Icon + plain text (no pill) — for lists, property rows and menus. */
@Component({
  selector: 'app-status-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon],
  host: { class: 'inline-flex items-center gap-1.5 whitespace-nowrap' },
  template: `
    <app-status-icon [status]="status()" [entity]="entity()" />
    <span>{{ label() ?? visual().label }}</span>
  `,
})
export class StatusLabel {
  readonly status = input.required<AnyStatus>();
  readonly label = input<string>();
  readonly entity = input<StatusEntity>('auto');
  protected readonly visual = computed(() => STATUS_VISUALS[this.status()]);
}
