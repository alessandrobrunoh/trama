/**
 * v3 atoms ("v3 · 01 UI Kit" → Atoms in docs/designs/untitled.pen). Square, hairline, mono.
 *   <v3-status status="in_progress" />          ■ In progress (hairline box)
 *   <v3-priority priority="high" [label]="true" /> ▮▮▯ High
 *   <v3-thread [issue]="issue" />                ■ Thread linked | No thread
 *   <v3-source [issue]="issue" />                ⌥ acme/web#412 | Trama
 *   <v3-est [value]="3" />                       EST 3
 *   <v3-check [done]="true" />                   ☑
 */
import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
  model,
} from '@angular/core';
import { LucideCheck, LucideDynamicIcon, LucidePenLine, LucideSquareKanban } from '@lucide/angular';
import { resolveStatusEntry, type Issue, type Priority } from '../core/contracts/domain';
import { TramaStore } from '../core/stores/trama.store';

/** Fallback square colors when a status has no catalog entry (v3 Foundations). */
const STATUS_DOT: Record<string, string> = {
  draft: '#5e6269',
  backlog: '#5e6269',
  todo: '#8c9096',
  in_progress: '#e2a93b',
  in_review: '#5274e0',
  done: '#6fae73',
  canceled: '#3a3e45',
};

/** Status: 7px square in the status color + mono 11px label, in a 1px hairline box (3px / 8px). */
@Component({
  selector: 'v3-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border text-foreground inline-flex shrink-0 items-center gap-1.5 border px-2 py-[3px] font-mono text-[11px] leading-[13px] whitespace-nowrap',
  },
  template: `<span class="size-[7px] shrink-0" [style.background]="color()" aria-hidden="true"></span>{{ label() }}`,
})
export class V3Status {
  readonly status = input.required<string>();
  private readonly store = inject(TramaStore);
  private readonly entry = computed(() =>
    resolveStatusEntry(this.store.settings().statuses.issue, this.status()),
  );
  protected readonly color = computed(() => this.entry()?.color ?? STATUS_DOT[this.status()] ?? '#8c9096');
  protected readonly label = computed(() => this.entry()?.name ?? this.status());
}

const PRIORITY_LIT: Record<Priority, number> = { urgent: 3, high: 2, medium: 1, low: 0, none: 0 };
const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
};

/** Priority: three 3px bars (5 / 8 / 11px), lit bars in text color (urgent: all red) + mono label. */
@Component({
  selector: 'v3-priority',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] leading-none whitespace-nowrap',
    '[class.text-red]': "priority() === 'urgent'",
    '[class.text-muted-foreground]': "priority() !== 'urgent'",
    '[attr.aria-label]': "'Priority: ' + text()",
  },
  template: `
    <span class="flex h-[11px] items-end gap-0.5" aria-hidden="true">
      @for (h of heights; track $index) {
        <span class="w-[3px]" [style.height.px]="h" [class]="barClass($index)"></span>
      }
    </span>
    @if (label()) {
      <span>{{ text() }}</span>
    }
  `,
})
export class V3Priority {
  readonly priority = input.required<Priority>();
  readonly label = input(true, { transform: booleanAttribute });
  protected readonly heights = [5, 8, 11];
  protected readonly text = computed(() => PRIORITY_LABEL[this.priority()] ?? this.priority());
  protected barClass(i: number): string {
    const p = this.priority();
    if (p === 'urgent') return 'bg-red';
    return i < PRIORITY_LIT[p] ? 'bg-foreground' : 'bg-faint';
  }
}

/** Thread link chip: blue "Thread linked", gray "No thread", yellow "Record stale · 3d". */
@Component({
  selector: 'v3-thread',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'inline-flex shrink-0 items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px] leading-[14px] whitespace-nowrap',
    '[class]': 'tone()',
  },
  template: `<span class="size-1.5 shrink-0" [class]="dot()" aria-hidden="true"></span>{{ text() }}`,
})
export class V3Thread {
  /** `linked` / `none` / `stale`; derived from the issue's thread link when an issue is given. */
  readonly issue = input<Pick<Issue, 'threadUrl'> | null>(null);
  readonly state = input<'linked' | 'none' | 'stale' | null>(null);
  /** Override the label ("Thread", "Record stale · 3d"). */
  readonly label = input<string | null>(null);
  private readonly resolved = computed(
    () => this.state() ?? (this.issue()?.threadUrl ? 'linked' : 'none'),
  );
  protected readonly text = computed(() => {
    if (this.label()) return this.label();
    const s = this.resolved();
    return s === 'linked' ? 'Thread linked' : s === 'stale' ? 'Record stale' : 'No thread';
  });
  protected readonly tone = computed(() => {
    const s = this.resolved();
    if (s === 'linked') return 'border-delta-line/40 text-delta';
    if (s === 'stale') return 'border-status-in-progress/40 text-status-in-progress';
    return 'border-border text-faint';
  });
  protected readonly dot = computed(() => {
    const s = this.resolved();
    if (s === 'linked') return 'bg-delta-line';
    if (s === 'stale') return 'bg-status-in-progress';
    return 'bg-faint';
  });
}

/** Where an issue came from, as the v3 kit writes it: acme/web#412 · infra/api!88 · JIRA OPS-219 · Trama. */
export function sourceRef(issue: Pick<Issue, 'externalUrl' | 'source'>): {
  kind: 'github' | 'gitlab' | 'jira' | 'trama';
  label: string;
  url?: string;
} {
  const url = issue.externalUrl;
  if (url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (u.hostname.includes('github')) {
        const [owner, repo, , num] = parts;
        if (owner && repo && num) return { kind: 'github', label: `${owner}/${repo}#${num}`, url };
      }
      if (u.hostname.includes('gitlab')) {
        const dash = parts.indexOf('-');
        const repo = parts.slice(0, dash > 0 ? dash : 2).join('/');
        const type = dash > 0 ? parts[dash + 1] : '';
        const num = dash > 0 ? parts[dash + 2] : '';
        if (repo && num) return { kind: 'gitlab', label: `${repo}${type === 'merge_requests' ? '!' : '#'}${num}`, url };
      }
      if (u.hostname.includes('atlassian') || u.pathname.includes('/browse/')) {
        const key = parts[parts.length - 1];
        if (key) return { kind: 'jira', label: `JIRA ${key}`, url };
      }
    } catch {
      /* not a URL */
    }
  }
  if (issue.source === 'github') return { kind: 'github', label: 'GitHub', url };
  if (issue.source === 'gitlab') return { kind: 'gitlab', label: 'GitLab', url };
  return { kind: 'trama', label: 'Trama' };
}

/** Source chip: raised fill, 11px icon + mono 10.5px label. */
@Component({
  selector: 'v3-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class:
      'bg-secondary text-muted-foreground inline-flex shrink-0 items-center gap-[5px] px-[7px] py-0.5 font-mono text-[10.5px] leading-[14px] whitespace-nowrap',
  },
  template: `
    @switch (ref().kind) {
      @case ('github') {
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
      }
      @case ('gitlab') {
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z" />
        </svg>
      }
      @case ('jira') {
        <svg [lucideIcon]="kanban" [size]="11"></svg>
      }
      @default {
        <svg [lucideIcon]="pen" [size]="11"></svg>
      }
    }
    {{ ref().label }}
  `,
})
export class V3Source {
  readonly issue = input.required<Pick<Issue, 'externalUrl' | 'source'>>();
  protected readonly ref = computed(() => sourceRef(this.issue()));
  protected readonly kanban = LucideSquareKanban;
  protected readonly pen = LucidePenLine;
}

/** Estimate chip: "EST" 9.5px faint + value 11px semibold, hairline box. Tones: warn (over), muted (none), suggested (blue). */
@Component({
  selector: 'v3-est',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex shrink-0 items-center gap-[5px] border px-1.5 py-0.5 font-mono whitespace-nowrap',
    '[class]': 'boxTone()',
  },
  template: `
    <span class="text-[9.5px] leading-[13px]" [class]="labelTone()">EST</span>
    <span class="text-[11px] leading-[14px] font-semibold" [class]="valueTone()">{{ text() }}</span>
  `,
})
export class V3Est {
  readonly value = input<number | null | undefined>(null);
  /** Extra text after the value ("13h of ~10h"). */
  readonly extra = input<string | null>(null);
  readonly tone = input<'default' | 'warn' | 'suggested'>('default');
  protected readonly empty = computed(() => this.value() == null);
  protected readonly text = computed(() => {
    const v = this.value();
    if (v == null) return '—';
    return this.extra() ? `${v} · ${this.extra()}` : String(v);
  });
  protected readonly boxTone = computed(() => {
    if (this.tone() === 'warn') return 'border-status-in-progress/40';
    if (this.tone() === 'suggested') return 'border-delta-line/40';
    return this.empty() ? 'border-[#3a3e45]' : 'border-border';
  });
  protected readonly labelTone = computed(() => {
    if (this.tone() === 'warn') return 'text-status-in-progress';
    if (this.tone() === 'suggested') return 'text-delta';
    return 'text-faint';
  });
  protected readonly valueTone = computed(() => {
    if (this.tone() === 'warn') return 'text-status-in-progress';
    if (this.tone() === 'suggested') return 'text-delta';
    return this.empty() ? 'text-faint' : 'text-foreground';
  });
}

/** Check: 14px hairline square; done = green fill with a dark check. */
@Component({
  selector: 'v3-check',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class: 'inline-flex size-3.5 shrink-0 items-center justify-center',
    '[class]': "done() ? 'bg-status-done' : 'border border-faint'",
  },
  template: `
    @if (done()) {
      <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3" class="text-background"></svg>
    }
  `,
})
export class V3Check {
  readonly done = input(false, { transform: booleanAttribute });
  protected readonly check = LucideCheck;
}

/** Section heading: Newsreader 21px + mono 10.5px faint caption, baseline aligned. */
@Component({
  selector: 'v3-section-title',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex w-full items-end gap-2.5' },
  template: `
    <h2 class="font-title text-foreground text-[21px] leading-[20px]">{{ title() }}</h2>
    @if (caption()) {
      <span class="text-faint pb-[3px] font-mono text-[10.5px] leading-none">{{ caption() }}</span>
    }
    <span class="flex-1"></span>
    <ng-content />
  `,
})
export class V3SectionTitle {
  readonly title = input.required<string>();
  readonly caption = input<string>();
}

export const V3 = [V3Status, V3Priority, V3Thread, V3Source, V3Est, V3Check, V3SectionTitle] as const;

/**
 * Toggle (v3 Forms → Toggle row): 30×16 square switch, 2px padding, 12×12 knob.
 * On = accent fill, white knob on the right; off = raised fill, faint knob on the left.
 * Same API as `<hlm-switch>`: `[checked]`, `(checkedChange)`, `[disabled]`, `aria-label`.
 */
@Component({
  selector: 'v3-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex shrink-0',
    '[attr.aria-label]': 'null',
  },
  template: `
    <button
      type="button"
      role="switch"
      class="focus-visible:ring-ring/50 flex h-4 w-[30px] shrink-0 items-start p-0.5 transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
      [class]="checked() ? 'bg-primary justify-end' : 'bg-secondary justify-start'"
      [attr.aria-checked]="checked()"
      [attr.aria-label]="ariaLabel()"
      [disabled]="disabled()"
      (click)="checked.set(!checked())"
    >
      <span class="size-3" [class]="checked() ? 'bg-white' : 'bg-faint'" aria-hidden="true"></span>
    </button>
  `,
})
export class V3Toggle {
  readonly checked = model(false);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
}

/** One choice of a segmented control. */
export interface V3SegmentOption {
  value: string;
  label: string;
}

/**
 * Segmented control (v3 Forms → Segmented): 22px, a hairline around the group and between segments,
 * mono 11px; the selected segment is raised and in text color, the others muted.
 */
@Component({
  selector: 'v3-segmented',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'border-border inline-flex w-fit shrink-0 items-stretch border',
    role: 'radiogroup',
    '[attr.aria-label]': 'ariaLabel()',
  },
  template: `
    @for (o of options(); track o.value; let first = $first) {
      <button
        type="button"
        role="radio"
        class="focus-visible:ring-ring/50 h-[20px] px-[9px] font-mono text-[11px] leading-[20px] whitespace-nowrap outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
        [class]="
          (first ? '' : 'border-border border-l ') +
          (o.value === value() ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')
        "
        [attr.aria-checked]="o.value === value()"
        [disabled]="disabled()"
        (click)="value.set(o.value)"
      >
        {{ o.label }}
      </button>
    }
  `,
})
export class V3Segmented {
  readonly options = input.required<readonly V3SegmentOption[]>();
  readonly value = model<string>('');
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
}

export const V3_FORMS = [V3Toggle, V3Segmented] as const;

/** Status square on its own (group headers, board columns): `size` px, in the status color. */
@Component({
  selector: 'v3-status-dot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-block shrink-0',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.background]': 'color()',
    'aria-hidden': 'true',
  },
  template: '',
})
export class V3StatusDot {
  readonly status = input.required<string>();
  readonly size = input(8);
  private readonly store = inject(TramaStore);
  protected readonly color = computed(
    () =>
      resolveStatusEntry(this.store.settings().statuses.issue, this.status())?.color ??
      STATUS_DOT[this.status()] ??
      '#8c9096',
  );
}
