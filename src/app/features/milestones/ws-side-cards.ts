// Right-sidebar "quick stats" of a workstream (Linear project sidebar): Progress, Milestones, Activity.
// Compact and read-only: milestones belong to the project, which is where they are planned and edited.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NablaStore, shortDate, type Workstream } from '../../core';
import { AiActions } from '../ai-actions/ai-actions.service';
import { AiButton } from '../ai-actions/ai-button';
import { EventLine } from '../overview/event-line';
import { MilestoneIcon } from './milestone-icon';
import { MilestoneInfo } from './milestone-stats';
import { fmtNum, progressLabel, totalsOf } from './milestone-model';
import { ProgressChart } from './progress-chart';

@Component({
  selector: 'app-ws-side-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MilestoneIcon, ProgressChart, EventLine, AiButton],
  host: { class: 'flex flex-col gap-3' },
  template: `
    <!-- Progress -->
    <section class="bg-card border-border-strong rounded-lg border px-3 pt-2.5 pb-2" aria-label="Progress">
      <div class="mb-2 flex items-center">
        <h3 class="text-[13px] font-medium">Progress</h3>
        <app-ai-button
          class="ml-auto -mr-1"
          label="Draft update"
          variant="ghost"
          size="xs"
          tooltip="Draft a stakeholder status update from this workstream's data"
          hideWhenUnavailable
          (pressed)="ai.request('update', ws().id)"
        />
      </div>
      <div class="grid grid-cols-3 gap-2">
        @for (s of summary(); track s.label) {
          <div class="min-w-0">
            <div class="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <span class="size-2 shrink-0 rounded-[2px]" [style.background]="s.color"></span>{{ s.label }}
            </div>
            <div class="mt-0.5 text-sm font-medium tabular-nums">{{ s.value }}</div>
          </div>
        }
      </div>
      <p class="text-muted-foreground mt-1 text-[11px]">in {{ unit() }}</p>
      @if (hasIssues()) {
        <div class="mt-1 -mx-1">
          <app-progress-chart [ws]="ws()" [height]="150" [showHeader]="false" [compact]="true" />
        </div>
      } @else {
        <p class="text-muted-foreground py-3 text-xs">Link issues to this workstream to see scope, started and completed over time.</p>
      }
    </section>

    <!-- Milestones -->
    <section class="bg-card border-border-strong rounded-lg border px-1.5 pt-2.5 pb-1.5" aria-label="Milestones">
      <div class="mb-1 flex items-center px-1.5">
        <h3 class="text-[13px] font-medium">Milestones</h3>
        <span class="text-muted-foreground ml-1.5 text-xs tabular-nums">{{ milestones().length }}</span>
        @if (project(); as p) {
          <a class="text-muted-foreground hover:text-foreground ml-auto truncate text-xs hover:underline" [routerLink]="['/', store.slug(), 'projects', p.id]">{{ p.name }}</a>
        }
      </div>
      @for (m of milestones(); track m.id; let i = $index) {
        @let st = info.stats().get(m.id);
        <button
          type="button"
          class="hover:bg-accent flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-start"
          (click)="scrollToMilestones()"
        >
          <app-milestone-icon [size]="14" [state]="info.states().get(m.id) ?? 'idle'" [fraction]="st?.fraction ?? 0" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px]">{{ m.name }}</span>
            @if (st) {
              <span class="text-muted-foreground block text-[11px]">{{ label(m.id) }}</span>
            }
          </span>
          @if (m.targetDate) {
            <span class="text-muted-foreground shrink-0 text-xs" [class.text-tone-red]="info.states().get(m.id) === 'overdue'">{{ date(m.targetDate) }}</span>
          }
        </button>
      } @empty {
        <p class="text-muted-foreground px-1.5 py-2 text-xs">
          @if (project(); as p) {
            The project has no milestones yet.
            <a class="text-foreground underline-offset-2 hover:underline" [routerLink]="['/', store.slug(), 'projects', p.id]">Plan them in the project</a>
          } @else {
            Milestones belong to a project. Add this workstream to a project to plan stages with their own issues and dates.
          }
        </p>
      }
    </section>

    <!-- Activity -->
    <section class="bg-card border-border-strong rounded-lg border px-3 pt-2.5 pb-1.5" aria-label="Activity">
      <div class="mb-0.5 flex items-center">
        <h3 class="text-[13px] font-medium">Activity</h3>
        <button type="button" class="text-muted-foreground hover:text-foreground ml-auto text-xs" (click)="openActivity()">See all</button>
      </div>
      @for (e of recent(); track e.id) {
        <app-event-line [event]="e" [slug]="store.slug() ?? ''" compact hideDetail />
      } @empty {
        <p class="text-muted-foreground py-2 text-xs">Nothing yet.</p>
      }
    </section>
  `,
})
export class WsSideCards {
  protected readonly store = inject(NablaStore);
  protected readonly info = inject(MilestoneInfo);
  protected readonly ai = inject(AiActions);
  private readonly router = inject(Router);

  readonly ws = input.required<Workstream>();

  protected readonly date = shortDate;

  protected readonly project = computed(() => this.store.getProject(this.ws().projectId));
  protected readonly milestones = computed(() => this.store.milestonesByWorkstream().get(this.ws().id) ?? []);
  private readonly issues = computed(() => this.store.issuesByWorkstream().get(this.ws().id) ?? []);
  protected readonly hasIssues = computed(() => this.issues().some((i) => i.status !== 'canceled'));
  private readonly points = computed(() => this.info.pointsByWorkstream().get(this.ws().id) ?? false);
  protected readonly unit = computed(() => (this.points() ? 'points' : 'issues'));
  private readonly totals = computed(() => totalsOf(this.issues(), this.points()));
  protected readonly summary = computed(() => {
    const t = this.totals();
    return [
      { label: 'Scope', value: fmtNum(t.scope), color: 'var(--muted-foreground)' },
      { label: 'Started', value: fmtNum(t.started), color: 'var(--status-needs-input)' },
      { label: 'Completed', value: fmtNum(t.completed), color: 'var(--primary)' },
    ];
  });
  protected readonly recent = computed(() =>
    (this.store.eventsByWorkstream().get(this.ws().id) ?? [])
      .filter((e) => !(e.type === 'comment.created' && e.subject.type === 'workstream'))
      .slice(0, 4),
  );

  protected label(id: string): string {
    const s = this.info.stats().get(id);
    if (!s) return '';
    return s.scope === 0 ? 'No issues yet' : `${progressLabel(s)}`;
  }

  protected scrollToMilestones(): void {
    document.getElementById('project-milestones-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  protected openActivity(): void {
    void this.router.navigate([], { queryParams: { tab: 'activity' }, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
