import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { LucideCircleDashed, LucideDynamicIcon } from '@lucide/angular';
import { TramaStore, formatSpan } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { StatusIcon } from '../../shared/status';
import { PreviewLink } from '../issues/list-preview';
import { OverviewLinks } from './overview-links';
import type { Lane } from './overview-model';

/** Tasks a lane shows before it folds the rest behind "+N more". */
const VISIBLE = 5;

/**
 * "Now": one lane per person (or agent-less, owner-less work last) with the tasks they have in flight, as compact
 * chips. A pulsing dot marks the task you are tracking time on; an amber age marks work that went quiet.
 */
@Component({
  selector: 'app-overview-now',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar, LucideDynamicIcon, PreviewLink, StatusIcon],
  host: { class: 'block' },
  template: `
    @if (lanes().length === 0) {
      <p class="text-muted-foreground py-1 text-[13px]">Nobody has a task in progress.</p>
    } @else {
      <ul class="flex flex-col gap-3">
        @for (lane of lanes(); track lane.userId ?? 'none') {
          <li class="grid grid-cols-1 gap-x-4 gap-y-1.5 @2xl:grid-cols-[11rem_minmax(0,1fr)]">
            <div class="flex min-w-0 items-center gap-2 @2xl:h-7">
              @if (lane.userId) {
                <app-actor-avatar [actor]="{ type: 'user', id: lane.userId }" [size]="20" />
              } @else {
                <span class="text-muted-foreground inline-flex size-5 items-center justify-center" aria-hidden="true">
                  <svg [lucideIcon]="noOwner" [size]="18" [strokeWidth]="1.5"></svg>
                </span>
              }
              <span class="truncate text-[13px]">{{ name(lane) }}</span>
              <span class="text-meta ms-auto shrink-0 tabular-nums @2xl:ms-0">{{ lane.tasks.length }}</span>
            </div>

            <div class="flex min-w-0 flex-wrap items-center gap-1.5">
              @for (t of shown(lane); track t.issue.id) {
                <a
                  [appPreviewLink]="links.route(taskTarget(t.issue.key))"
                  (preview)="links.show(taskTarget(t.issue.key))"
                  class="bg-muted/70 hover:bg-muted focus-visible:ring-ring/50 flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none focus-visible:ring-2"
                  [class.ring-1]="links.isPreviewed(taskTarget(t.issue.key))"
                  [class.ring-primary]="links.isPreviewed(taskTarget(t.issue.key))"
                  [title]="t.issue.key + ' ' + t.issue.title"
                >
                  <app-status-icon entity="issue" [status]="t.issue.status" [size]="13" />
                  <span class="text-muted-foreground shrink-0 font-mono">{{ t.issue.key }}</span>
                  <span class="max-w-[16rem] min-w-0 truncate">{{ t.issue.title }}</span>
                  @if (t.timer) {
                    <span class="text-primary flex shrink-0 items-center gap-1" title="Your timer is running">
                      <span class="relative flex size-1.5">
                        <span class="bg-primary absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping"></span>
                        <span class="bg-primary relative inline-flex size-1.5 rounded-full"></span>
                      </span>
                      <span class="tabular-nums">{{ elapsed(t.timer.startedAt) }}</span>
                    </span>
                  } @else if (t.idle) {
                    <span class="shrink-0 tabular-nums" style="color: var(--tone-amber)" [title]="'Nothing has happened for ' + t.idleDays + ' days'">{{ t.idleDays }}d</span>
                  }
                </a>
              }
              @if (lane.tasks.length > VISIBLE) {
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground hover:bg-hover focus-visible:ring-ring/50 h-7 rounded-md px-2 text-xs outline-none focus-visible:ring-2"
                  [attr.aria-expanded]="isOpen(lane)"
                  (click)="toggle(lane)"
                >
                  {{ isOpen(lane) ? 'Show less' : '+' + (lane.tasks.length - VISIBLE) + ' more' }}
                </button>
              }
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class OverviewNow {
  protected readonly links = inject(OverviewLinks);
  private readonly store = inject(TramaStore);

  readonly lanes = input.required<readonly Lane[]>();
  /** Current time in ms, to age the running timers. */
  readonly now = input.required<number>();

  protected readonly VISIBLE = VISIBLE;
  protected readonly noOwner = LucideCircleDashed;
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected name(lane: Lane): string {
    if (!lane.userId) return 'Nobody yet';
    const user = this.store.getUser(lane.userId);
    if (!user) return 'Someone';
    return user.id === this.store.me()?.id ? `${user.name} (you)` : user.name;
  }

  protected taskTarget(key: string): { kind: 'task'; idOrKey: string } {
    return { kind: 'task', idOrKey: key };
  }

  protected shown(lane: Lane): Lane['tasks'] {
    return this.isOpen(lane) ? lane.tasks : lane.tasks.slice(0, VISIBLE);
  }

  protected isOpen(lane: Lane): boolean {
    return this.expanded().has(lane.userId ?? '');
  }

  protected toggle(lane: Lane): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      const id = lane.userId ?? '';
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected elapsed(startedAt: string): string {
    return formatSpan(this.now() - Date.parse(startedAt));
  }
}
