// Project preview for the right pane: name, health, lead, repository, progress, milestones and
// open tasks. Rendered by the shell for `RightPaneContent = { kind: 'project'; id }`.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { LucideDynamicIcon, LucideExternalLink } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { ActorAvatar } from '../../shared/actor-avatar';
import { StatusIcon } from '../../shared/status';
import { MilestoneIcon } from '../milestones/milestone-icon';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { milestoneStats, usesPoints } from '../milestones/milestone-model';
import { ProjectGlyph } from './project-glyph';
import { projectHealthView, projectStatusView } from './project-model';
import { isClosedIssue } from '../issues/issue-model';

const MAX_TASKS = 8;

@Component({
  selector: 'app-project-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    LucideDynamicIcon,
    ActorAvatar,
    StatusIcon,
    MilestoneIcon,
    ProjectGlyph,
  ],
  host: { class: 'block min-w-0 text-[13px]' },
  template: `
    @if (project(); as p) {
      <div class="flex flex-col gap-5 px-4 py-4">
        <header class="flex min-w-0 items-start gap-2.5">
          <app-project-glyph [project]="p" [size]="18" class="mt-0.5" />
          <div class="min-w-0 flex-1">
            <h2 class="text-base leading-snug break-words">{{ p.name }}</h2>
            @if (p.summary) {
              <p class="text-muted-foreground mt-0.5 line-clamp-3">{{ p.summary }}</p>
            }
          </div>
          <button hlmBtn variant="ghost" size="sm" class="-mr-1 shrink-0 gap-1.5" (click)="open()">
            <svg [lucideIcon]="openIcon" [size]="13"></svg>Open
          </button>
        </header>

        <dl class="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <dt class="text-muted-foreground">Status</dt>
          <dd class="flex min-w-0 items-center gap-1.5">
            <span class="size-2 shrink-0 rounded-full" [style.background]="status().color"></span>
            <span class="truncate">{{ status().label }}</span>
          </dd>
          <dt class="text-muted-foreground">Health</dt>
          <dd class="flex min-w-0 items-center gap-1.5">
            @if (health(); as h) {
              <span class="size-2 shrink-0 rounded-full" [style.background]="h.color"></span>
              <span class="truncate">{{ h.label }}</span>
            } @else {
              <span class="text-muted-foreground">Not set</span>
            }
          </dd>
          <dt class="text-muted-foreground">Lead</dt>
          <dd class="flex min-w-0 items-center gap-1.5">
            @if (p.leadId) {
              <app-actor-avatar [actor]="{ type: 'user', id: p.leadId }" [size]="18" />
              <span class="truncate">{{ lead() }}</span>
            } @else {
              <span class="text-muted-foreground">No lead</span>
            }
          </dd>
          <dt class="text-muted-foreground">Repository</dt>
          <dd class="min-w-0 truncate font-mono text-xs">
            @if (p.repository) {
              {{ p.repository }}
            } @else {
              <span class="text-muted-foreground font-sans text-[13px]">None</span>
            }
          </dd>
          <dt class="text-muted-foreground">Progress</dt>
          <dd class="flex min-w-0 items-center gap-2">
            <span class="bg-foreground/10 h-1.5 w-full max-w-28 overflow-hidden rounded-full" aria-hidden="true">
              <span
                class="bg-status-done block h-full rounded-full"
                [style.width.%]="progress().percent"
              ></span>
            </span>
            <span class="text-muted-foreground tabular-nums">
              {{ progress().percent }}% · {{ progress().doneIssues }}/{{ progress().issues }}
            </span>
          </dd>
        </dl>

        @if (milestones().length) {
          <section aria-label="Milestones">
            <h3 class="text-muted-foreground mb-1.5">Milestones</h3>
            <ul class="flex flex-col">
              @for (m of milestones(); track m.ms.id) {
                <li class="flex min-h-8 items-center gap-2">
                  <app-milestone-icon [size]="14" [state]="m.state" [fraction]="m.stats.fraction" />
                  <span class="min-w-0 flex-1 truncate">{{ m.ms.name }}</span>
                  <span class="text-muted-foreground text-xs tabular-nums">{{ m.stats.percent }}%</span>
                </li>
              }
            </ul>
          </section>
        }

        <section aria-label="Open tasks">
          <h3 class="text-muted-foreground mb-1.5">
            Open tasks <span class="tabular-nums">{{ openTasks().length }}</span>
          </h3>
          @if (openTasks().length) {
            <ul class="-mx-2 flex flex-col">
              @for (i of shownTasks(); track i.id) {
                <li>
                  <button
                    type="button"
                    class="hover:bg-hover flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left"
                    (click)="showTask(i.key)"
                  >
                    <app-status-icon entity="issue" [status]="i.status" />
                    <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ i.key }}</span>
                    <span class="min-w-0 flex-1 truncate">{{ i.title }}</span>
                  </button>
                </li>
              }
            </ul>
            @if (openTasks().length > shownTasks().length) {
              <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground -ml-2 mt-1" (click)="open()">
                {{ openTasks().length - shownTasks().length }} more in the project
              </button>
            }
          } @else {
            <p class="text-muted-foreground">Nothing open.</p>
          }
        </section>
      </div>
    } @else {
      <p class="text-muted-foreground px-4 py-4">This project is no longer available.</p>
    }
  `,
})
export class ProjectPreview {
  /** Project id. */
  readonly id = input.required<string>();

  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly pane = inject(RightPaneStore);
  private readonly info = inject(MilestoneInfo);

  protected readonly openIcon = LucideExternalLink;

  protected readonly project = computed(() => this.store.getProject(this.id()));
  private readonly entries = computed(() => this.store.settings().statuses);
  protected readonly status = computed(() =>
    projectStatusView(this.project()?.status ?? '', this.entries().project),
  );
  protected readonly health = computed(() =>
    projectHealthView(this.project()?.health, this.entries().projectHealth),
  );
  protected readonly lead = computed(() => {
    const id = this.project()?.leadId;
    return id ? this.store.userById().get(id)?.name : undefined;
  });
  private readonly tasks = computed(() => this.store.issuesByProject().get(this.id()) ?? []);
  protected readonly progress = computed(() =>
    milestoneStats(this.tasks(), usesPoints(this.tasks(), this.store.estimateScale())),
  );
  protected readonly milestones = computed(() => {
    const stats = this.info.stats();
    const states = this.info.states();
    return (this.store.milestonesByProject().get(this.id()) ?? []).flatMap((ms) => {
      const s = stats.get(ms.id);
      const state = states.get(ms.id);
      return s && state ? [{ ms, stats: s, state }] : [];
    });
  });
  protected readonly openTasks = computed(() =>
    this.tasks().filter((i) => !isClosedIssue(i, this.entries().issue)),
  );
  protected readonly shownTasks = computed(() => this.openTasks().slice(0, MAX_TASKS));

  protected open(): void {
    const slug = this.store.slug();
    if (slug) void this.router.navigate(['/', slug, 'projects', this.id()]);
  }

  protected showTask(idOrKey: string): void {
    this.pane.show({ kind: 'task', idOrKey });
  }
}
