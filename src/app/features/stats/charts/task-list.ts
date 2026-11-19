import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { StatusIcon } from '../../../shared/status';

export interface TaskListRow {
  id: string;
  key: string;
  title: string;
  /** Task status, for the glyph. */
  status?: string;
  /** One line under the title. */
  detail?: string;
  /** Short pill on the right ("Idle 12d", "3× longer"). */
  badge?: string;
  tone?: 'warn' | 'bad' | 'good' | 'muted';
}

/** Tasks as compact rows that open the task page, with a "show all" past `limit`. */
@Component({
  selector: 'app-task-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, StatusIcon],
  host: { class: 'block' },
  template: `
    <ul class="-mx-2 flex flex-col" [attr.aria-label]="ariaLabel()">
      @for (r of shown(); track r.id) {
        <li class="hover:bg-hover flex items-start gap-2 rounded-md px-2 py-1.5 text-xs">
          @if (r.status) {
            <app-status-icon class="mt-0.5" [status]="r.status" entity="issue" [size]="13" />
          }
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-baseline gap-2">
              <a class="text-muted-foreground hover:text-foreground shrink-0 font-mono" [routerLink]="['/', slug(), 'tasks', r.key]">{{ r.key }}</a>
              <a class="min-w-0 truncate text-[13px] hover:underline" [routerLink]="['/', slug(), 'tasks', r.key]">{{ r.title }}</a>
            </div>
            @if (r.detail) {
              <p class="text-muted-foreground mt-0.5">{{ r.detail }}</p>
            }
          </div>
          @if (r.badge) {
            <span class="shrink-0 rounded-full px-2 py-0.5 font-medium whitespace-nowrap" [class]="toneClass(r.tone)">{{ r.badge }}</span>
          }
        </li>
      }
    </ul>
    @if (rows().length > limit() && !all()) {
      <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground mt-1 w-full justify-start" (click)="all.set(true)">
        Show all {{ rows().length }}
      </button>
    }
  `,
})
export class TaskList {
  readonly rows = input.required<readonly TaskListRow[]>();
  readonly slug = input.required<string>();
  readonly limit = input(8);
  readonly ariaLabel = input<string | undefined>(undefined);
  protected readonly all = signal(false);
  protected readonly shown = computed(() => (this.all() ? this.rows() : this.rows().slice(0, this.limit())));

  protected toneClass(tone: TaskListRow['tone']): string {
    switch (tone) {
      case 'warn':
        return 'bg-status-needs-input/10 text-status-needs-input';
      case 'bad':
        return 'bg-status-blocked/10 text-status-blocked';
      case 'good':
        return 'text-status-shipped';
      default:
        return 'text-muted-foreground';
    }
  }
}
