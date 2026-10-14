import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
} from '@angular/core';
import {
  LucideCircle,
  LucideCircleAlert,
  LucideCircleCheck,
  LucideCircleDashed,
  LucideCircleMinus,
  LucideCircleX,
  LucideGitMerge,
  LucideRocket,
  type LucideIcon,
} from '@lucide/angular';
import { LucideDynamicIcon } from '@lucide/angular';
import {
  STATUS_CATALOG_KEY,
  resolveStatusEntry,
  type ArtifactState,
  type CiState,
  type DecisionStatus,
  type IssueStatus,
  type StatusEntry,
  type StatusSubject,
} from '../core/contracts/domain';
import { TramaStore } from '../core/stores/trama.store';
import { LucideNames, isLucideName } from './lucide-names';

/** Every enum value that has a status visual. */
export type AnyStatus = IssueStatus | DecisionStatus | ArtifactState | CiState;

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
  planned: { text: 'text-status-todo', pill: 'bg-status-todo/10 border-status-todo/25' },
  active: { text: 'text-status-in-progress', pill: 'bg-status-in-progress/10 border-status-in-progress/25' },
  input: {
    text: 'text-status-proposed',
    pill: 'bg-status-proposed/10 border-status-proposed/25',
  },
  review: {
    text: 'text-status-proposed',
    pill: 'bg-status-proposed/10 border-status-proposed/25',
  },
  danger: { text: 'text-status-rejected', pill: 'bg-status-rejected/10 border-status-rejected/25' },
  ready: {
    text: 'text-status-accepted',
    pill: 'bg-status-accepted/10 border-status-accepted/25',
  },
  done: { text: 'text-status-done', pill: 'bg-status-done/10 border-status-done/25' },
} as const;

const v = (label: string, tone: keyof typeof TONE, glyph: Glyph): StatusVisual => ({
  label,
  ...TONE[tone],
  glyph,
});
const icon = (i: LucideIcon): Glyph => ({ kind: 'icon', icon: i });

export const STATUS_VISUALS: Record<AnyStatus, StatusVisual> = {
  // IssueStatus
  draft: v('Draft', 'neutral', { kind: 'dashed' }),
  backlog: v('Backlog', 'neutral', { kind: 'dashed' }),
  todo: v('Todo', 'planned', icon(LucideCircle)),
  in_progress: v('In progress', 'active', { kind: 'pie', fraction: 0.5 }),
  in_review: v('In review', 'review', { kind: 'pie', fraction: 0.75 }),
  done: v('Done', 'done', icon(LucideCircleCheck)),
  canceled: v('Canceled', 'neutral', icon(LucideCircleX)),
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

/** Which glyph family to draw. Issues use circles; other resources use their catalog icon. */
export type StatusEntity = 'auto' | 'issue' | 'other';

const ISSUE_ONLY = new Set<string>(['backlog', 'todo', 'in_progress', 'done']);

type Shape = 'circle' | 'icon';
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

/**
 * Status glyph (14px by default). Issues use their circular lifecycle glyph; other resources use catalog icons.
 */
@Component({
  selector: 'app-status-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class: 'inline-flex shrink-0 items-center justify-center',
    '[class]': 'entry() ? "" : visual().text',
    '[style.color]': 'entry()?.color ?? null',
    '[attr.role]': '"img"',
    '[attr.aria-label]': 'entry()?.name ?? visual().label',
  },
  template: `
    @if (entry(); as e) {
      @if (emoji()) {
        <span class="leading-none select-none" [style.font-size.px]="size() * 0.85">{{ e.icon }}</span>
      } @else {
        <svg [lucideIcon]="lucide()" [size]="size()"></svg>
      }
    } @else {
    @switch (shape()) {
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
    }
  `,
})
export class StatusIcon {
  readonly status = input.required<string>();
  readonly size = input(14);
  /** Glyph family; `auto` infers it from the status value (shared values fall back to circles). */
  readonly entity = input<StatusEntity>('auto');
  /** When set, the icon, color and name come from this subject's catalog. */
  readonly subject = input<StatusSubject | null>(null);

  private static seq = 0;
  private readonly names = inject(LucideNames);
  private readonly store = inject(TramaStore);
  protected readonly dashed = LucideCircleDashed;
  protected readonly entry = computed(() => this.catalogEntry());
  protected readonly emoji = computed(() => {
    const icon = this.entry()?.icon;
    return icon && !isLucideName(icon) ? icon : null;
  });
  protected readonly lucide = computed(() => this.names.icon(this.entry()?.icon ?? 'circle'));
  protected readonly visual = computed(() => STATUS_VISUALS[this.status() as AnyStatus] ?? STATUS_VISUALS.draft);
  protected readonly shape = computed<Shape>(() => {
    const s = this.status();
    const e = this.entity();
    if (e === 'issue' && CIRCLE[s]) return 'circle';
    if (e === 'other') return 'icon';
    if (ISSUE_ONLY.has(s) || (e === 'auto' && CIRCLE[s] && s !== 'canceled')) return 'circle';
    return 'icon';
  });
  protected readonly circle = computed(() => CIRCLE[this.status()] ?? CIRCLE['todo']);

  /** Catalog entry for an explicit subject/entity, or for an unambiguous auto status. */
  private catalogEntry(): StatusEntry | undefined {
    const status = this.status();
    const catalog = this.store.settings().statuses;
    const subject = this.subject();
    if (subject) return resolveStatusEntry(catalog[STATUS_CATALOG_KEY[subject]], status);
    const entity = this.entity();
    if (entity === 'issue') return resolveStatusEntry(catalog.issue, status);
    if (entity === 'other') return resolveStatusEntry(catalog.decision, status);
    const lists = [catalog.issue, catalog.decision];
    const hits = lists.filter((entries) => entries.some((entry) => entry.id === status || entry.type === status));
    if (hits.length !== 1) return undefined;
    return resolveStatusEntry(hits[0], status);
  }

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
    <app-status-icon [status]="status()" [entity]="entity()" [subject]="subject()" [size]="12" />
    @if (!iconOnly()) {
      <!-- the glyph carries the colour; text stays neutral (Linear-style chip) -->
      <span>{{ label() ?? name() }}</span>
    }
  `,
})
export class StatusBadge {
  readonly status = input.required<string>();
  /** Override the default label (e.g. "Open · 2"). */
  readonly label = input<string>();
  readonly iconOnly = input(false, { transform: booleanAttribute });
  readonly entity = input<StatusEntity>('auto');
  readonly subject = input<StatusSubject | null>(null);

  private readonly store = inject(TramaStore);
  protected readonly visual = computed(() => STATUS_VISUALS[this.status() as AnyStatus] ?? STATUS_VISUALS.draft);
  protected readonly name = computed(() => this.catalogName(this.status()) ?? this.visual().label);

  private catalogName(status: string): string | undefined {
    const catalog = this.store.settings().statuses;
    const subject = this.subject();
    if (subject) return resolveStatusEntry(catalog[STATUS_CATALOG_KEY[subject]], status)?.name;
    const entity = this.entity();
    if (entity === 'issue') return resolveStatusEntry(catalog.issue, status)?.name;
    if (entity === 'other') return resolveStatusEntry(catalog.decision, status)?.name;
    return undefined;
  }
}

/** Icon + plain text (no pill) — for lists, property rows and menus. */
@Component({
  selector: 'app-status-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon],
  host: { class: 'inline-flex items-center gap-1.5 whitespace-nowrap' },
  template: `
    <app-status-icon [status]="status()" [entity]="entity()" [subject]="subject()" />
    <span>{{ label() ?? name() }}</span>
  `,
})
export class StatusLabel {
  readonly status = input.required<string>();
  readonly label = input<string>();
  readonly entity = input<StatusEntity>('auto');
  readonly subject = input<StatusSubject | null>(null);

  private readonly store = inject(TramaStore);
  protected readonly visual = computed(() => STATUS_VISUALS[this.status() as AnyStatus] ?? STATUS_VISUALS.draft);
  protected readonly name = computed(() => {
    const catalog = this.store.settings().statuses;
    const subject = this.subject();
    const entries = subject
      ? catalog[STATUS_CATALOG_KEY[subject]]
      : this.entity() === 'issue'
        ? catalog.issue
        : null;
    return (entries ? resolveStatusEntry(entries, this.status())?.name : undefined) ?? this.visual().label;
  });
}
