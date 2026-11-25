import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LucideBookOpen, LucideDynamicIcon } from '@lucide/angular';

interface Term {
  term: string;
  tag: string;
  body: string;
}

interface Update {
  date: string;
  who: string;
  whoBg: string;
  kicker?: string;
  text: string;
  ref: string;
}

interface ArcPoint {
  /** Position in the 1160 × 120 plot space. */
  x: number;
  y: number;
  label: string;
  /** Label offset from the marker, in plot px. */
  dx: number;
  dy: number;
  tone?: 'now' | 'done';
}

/** Width of the arc plot in the frame; markers are placed in percent of it so the chart scales. */
const PLOT_W = 1160;

/**
 * "Every project has a plot" (landing §02): what a project Updates page holds, a mock of it and the scope
 * and risk chart. Illustrative content, no store.
 */
@Component({
  selector: 'app-landing-plot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    <div
      class="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 pt-16 pb-14 md:gap-14 md:px-10 md:pt-[120px] md:pb-28 xl:px-[120px]"
    >
      <div class="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-2.5 font-mono text-[12px]">
            <span class="text-primary">02</span>
            <span class="text-faint tracking-[1.2px]">TRAMA · THE PLOT</span>
          </div>
          <h2
            class="font-title text-foreground text-[clamp(36px,3.6vw,52px)] leading-[1.077] tracking-[-0.019em]"
          >
            Every project<br />has a plot.
          </h2>
        </div>
        <p class="text-muted-foreground max-w-[380px] text-[16px] leading-[26px]">
          Trama is Italian for the plot of a play: the thread that holds the story together on stage.
          Delta does the work. Trama tells it, act by act and scene by scene, until the curtain falls.
        </p>
      </div>

      <div class="flex flex-col gap-10 lg:flex-row lg:gap-16">
        <dl class="flex flex-col lg:w-[520px] lg:shrink-0">
          @for (row of terms; track row.term; let first = $first) {
            <div
              class="border-border flex gap-5 border-b py-4"
              [class.border-t]="first"
            >
              <dt class="flex w-[130px] shrink-0 flex-col gap-1 sm:w-[170px]">
                <span class="font-title text-foreground text-[22px] leading-tight tracking-[-0.014em]">{{
                  row.term
                }}</span>
                <span class="text-primary font-mono text-[10.5px]">{{ row.tag }}</span>
              </dt>
              <dd class="text-muted-foreground min-w-0 flex-1 text-[14px] leading-[22px]">
                {{ row.body }}
              </dd>
            </div>
          }
        </dl>

        <div
          class="bg-card border-border flex min-w-0 flex-1 flex-col gap-6 border p-5 md:p-7"
          role="img"
          aria-label="Preview of a project Updates page for the v1.2 Records milestone"
        >
          <div class="flex items-center gap-2.5 font-mono text-[11px]">
            <svg [lucideIcon]="bookIcon" [size]="14" class="text-muted-foreground"></svg>
            <span class="text-muted-foreground truncate">acme / Web app / Updates</span>
            <span class="flex-1"></span>
            <span class="text-faint shrink-0 max-sm:hidden">milestone 3 of 4</span>
          </div>
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-end gap-x-3.5 gap-y-1">
              <span class="font-title text-foreground text-[22px] leading-none tracking-[-0.014em]"
                >v1.2 Records</span
              >
              <span class="text-faint font-mono text-[10.5px]"
                >MILESTONE · NOV 18 → DEC 12 · IN PROGRESS</span
              >
              <span class="flex-1"></span>
              <span class="text-muted-foreground font-mono text-[10.5px]"
                >key events · 5 of 9 tasks done</span
              >
            </div>
            <div class="flex flex-col">
              @for (u of updates; track u.date) {
                <div
                  class="border-border flex gap-3.5 px-3.5 py-[11px]"
                  [class]="
                    u.kicker ? 'bg-primary/10 border-l-primary border-l-2' : 'border-b'
                  "
                >
                  <span class="text-faint w-[52px] shrink-0 font-mono text-[11px]">{{ u.date }}</span>
                  <span
                    class="flex size-5 shrink-0 items-center justify-center font-mono text-[8.5px] text-[#dce3f7]"
                    [style.background]="u.whoBg"
                    >{{ u.who }}</span
                  >
                  <span class="flex min-w-0 flex-1 flex-col gap-1">
                    @if (u.kicker) {
                      <span class="text-primary font-mono text-[9.5px]">{{ u.kicker }}</span>
                    }
                    <span
                      class="text-[13px] leading-[19px]"
                      [class]="u.kicker ? 'text-foreground' : 'text-text-2'"
                      >{{ u.text }}</span
                    >
                  </span>
                  <span class="text-faint shrink-0 font-mono text-[10.5px] max-sm:hidden">{{
                    u.ref
                  }}</span>
                </div>
              }
            </div>
          </div>
        </div>
      </div>

      <!-- Scope & risk -->
      <div
        class="bg-card border-border flex flex-col gap-3.5 border p-5"
        role="img"
        aria-label="Scope and risk across milestones: three decisions and a scope change, with the release forecast on Dec 12"
      >
        <div class="flex items-center gap-4">
          <span class="text-foreground font-mono text-[10px]">SCOPE &amp; RISK · ALL MILESTONES</span>
          <span class="flex-1"></span>
          <span class="text-faint flex items-center gap-1.5 font-mono text-[10.5px]">
            <span class="bg-primary h-0.5 w-3.5"></span>actual
          </span>
          <span class="text-faint flex items-center gap-1.5 font-mono text-[10.5px]">
            <span class="bg-faint h-0.5 w-3.5"></span>forecast
          </span>
        </div>
        <div class="overflow-x-auto">
          <div class="relative h-[144px] min-w-[760px]">
            <span class="bg-border absolute top-[120px] right-0 left-0 h-px"></span>
            <span class="bg-border absolute top-0 h-[120px] w-px" [style.left]="pct(386)"></span>
            <span class="bg-border absolute top-0 h-[120px] w-px" [style.left]="pct(774)"></span>
            <svg
              class="absolute top-0 left-0 h-[120px] w-full overflow-visible"
              viewBox="0 0 1160 120"
              preserveAspectRatio="none"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M0 107 C120 105 250 95 384 84 S520 66 598 60 S700 50 772 44 S830 32 858 27"
                class="stroke-primary"
                stroke-width="2"
                vector-effect="non-scaling-stroke"
              />
              <path
                d="M858 27 C940 14 1000 8 1053 10 S1130 40 1160 69"
                class="stroke-faint"
                stroke-width="1.5"
                stroke-dasharray="4 4"
                vector-effect="non-scaling-stroke"
              />
            </svg>
            <span
              class="bg-primary/40 absolute top-0 h-[120px] w-px"
              [style.left]="pct(858)"
            ></span>
            @for (p of points; track p.label) {
              <span
                class="bg-background absolute size-2 outline-2 -outline-offset-1"
                [class]="p.tone === 'done' ? 'outline-faint' : 'outline-primary'"
                [style.left]="pct(p.x)"
                [style.top.px]="p.y - 4"
              ></span>
              <span
                class="absolute font-mono text-[9.5px] whitespace-nowrap"
                [class]="
                  p.tone === 'now'
                    ? 'text-primary'
                    : p.tone === 'done'
                      ? 'text-faint'
                      : 'text-muted-foreground'
                "
                [style.left]="pct(p.x + p.dx)"
                [style.top.px]="p.y + p.dy"
                >{{ p.label }}</span
              >
            }
            <span
              class="text-primary absolute font-mono text-[9.5px] whitespace-nowrap"
              [style.left]="pct(867)"
              [style.top.px]="104"
              >TODAY · NOV 25</span
            >
            <span
              class="text-faint absolute top-[128px] font-mono text-[9.5px] whitespace-nowrap"
              [style.left]="pct(12)"
              >v1.0 FOUNDATIONS · DONE</span
            >
            <span
              class="text-faint absolute top-[128px] font-mono text-[9.5px] whitespace-nowrap"
              [style.left]="pct(398)"
              >v1.1 THREADS · DONE</span
            >
            <span
              class="text-foreground absolute top-[128px] font-mono text-[9.5px] whitespace-nowrap"
              [style.left]="pct(786)"
              >v1.2 RECORDS · IN PROGRESS</span
            >
          </div>
        </div>
      </div>
    </div>
  `,
})
export class LandingPlot {
  protected readonly bookIcon = LucideBookOpen;

  protected readonly terms: readonly Term[] = [
    {
      term: 'Updates',
      tag: '= drafted by Delta',
      body: 'Delta writes where each project stands, from its thread records.',
    },
    {
      term: 'Milestones',
      tag: '= with a recap',
      body: 'Each milestone closes with a short recap of what shipped and what changed.',
    },
    {
      term: 'Key events',
      tag: '= not every task',
      body: 'Only what moves the project: merged PRs, status changes, blockers.',
    },
    {
      term: 'People & agents',
      tag: '= who did what',
      body: 'Who acted and how often. Agents count as contributors.',
    },
    {
      term: 'Decisions',
      tag: '= kept as records',
      body: 'Choices that change the plan are saved with who made them and why.',
    },
    {
      term: 'Scope changes',
      tag: '= flagged on the chart',
      body: 'When scope grows or risk jumps, Trama marks it on the progress chart.',
    },
  ];

  protected readonly updates: readonly Update[] = [
    {
      date: 'Nov 24',
      who: 'AB',
      whoBg: '#2b3a5c',
      kicker: 'DECISION',
      text: 'Alessandro decided that a record is frozen once its Delta thread closes. Later edits create a new record.',
      ref: 'DEC-14',
    },
    {
      date: 'Nov 22',
      who: 'Δ',
      whoBg: 'color-mix(in srgb, var(--primary) 20%, transparent)',
      text: 'Delta agent opened PR #482, “Rotate OAuth tokens before expiry”, from the thread on TRM-128.',
      ref: 'TRM-128',
    },
    {
      date: 'Nov 21',
      who: 'MR',
      whoBg: '#4a2c26',
      text: 'Marta moved “Record diff viewer” to In review, with 3 of 4 subtasks done.',
      ref: 'TRM-131',
    },
    {
      date: 'Nov 19',
      who: 'LS',
      whoBg: '#2e4430',
      kicker: 'SCOPE CHANGE',
      text: 'Scope grew by 6 points when the shared-view export was added to the milestone.',
      ref: 'TRM-140',
    },
    {
      date: 'Nov 18',
      who: 'AB',
      whoBg: '#2b3a5c',
      text: 'Milestone started. Goal: ship v1.2 Records by Dec 12, with 9 tasks planned.',
      ref: 'v1.2',
    },
  ];

  protected readonly points: readonly ArcPoint[] = [
    { x: 384, y: 84, label: 'DECISION · one thread per task', dx: 21, dy: 10 },
    { x: 598, y: 60, label: 'SCOPE +6 pts', dx: 21, dy: 10 },
    { x: 772, y: 44, label: 'DECISION · records are immutable', dx: 21, dy: 10 },
    { x: 1053, y: 10, label: 'RELEASE · DEC 12', dx: -118, dy: 14, tone: 'done' },
  ];

  /** Plot x (in the 1160-wide frame) as a percentage of the chart width. */
  protected pct(x: number): string {
    return `${(x / PLOT_W) * 100}%`;
  }
}
