// Project rows and board cards for saved views over projects: glyph, name, priority, status,
// health, lead and target date. The whole row/card is a link to the project page.
import { ChangeDetectionStrategy, Component, Directive, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NablaStore, type Project } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { FullDatePipe } from '../../shared/pipes';
import { PriorityIcon } from '../../shared/priority-icon';
import { ProjectGlyph } from '../projects/project-glyph';
import { ProjectHealthBadge } from '../projects/project-health';
import { PROJECT_STATUS_META, isOverdue } from '../projects/project-model';

@Directive()
abstract class ProjectItemBase {
  protected readonly store = inject(NablaStore);
  readonly project = input.required<Project>();
  readonly focused = input(false);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly status = computed(() => PROJECT_STATUS_META[this.project().status]);
  protected readonly overdue = computed(() => isOverdue(this.project()));
}

/** One dense list row: glyph · name · priority · status · health · lead · target date. */
@Component({
  selector: 'app-view-project-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ActorAvatar, FullDatePipe, PriorityIcon, ProjectGlyph, ProjectHealthBadge],
  host: { class: 'block' },
  template: `
    @let p = project();
    <a
      [routerLink]="['/', slug(), 'projects', p.id]"
      [attr.data-row-id]="p.id"
      class="hover:bg-hover focus-visible:bg-hover flex min-h-10 items-center gap-3 border-b px-4 py-1.5 outline-none sm:px-6"
      [class.bg-selected]="focused()"
    >
      <app-project-glyph [project]="p" [size]="16" />
      <span class="min-w-0 flex-1 truncate text-sm" [class.text-muted-foreground]="p.status === 'canceled'">{{ p.name }}</span>
      <app-priority-icon [priority]="p.priority" class="max-md:hidden" />
      <span class="flex w-28 shrink-0 items-center gap-1.5 text-xs max-sm:hidden" [class]="status().text">
        <span class="size-2 shrink-0 rounded-full" [class]="status().dot"></span>{{ status().label }}
      </span>
      <span class="flex w-24 shrink-0 items-center max-md:hidden">
        @if (p.health) {
          <app-project-health [health]="p.health" [compact]="true" />
        } @else {
          <span class="text-muted-foreground text-xs" aria-label="No update yet">—</span>
        }
      </span>
      <span class="flex w-6 shrink-0 justify-center max-sm:hidden">
        @if (p.leadId) {
          <app-actor-avatar [actor]="{ type: 'user', id: p.leadId }" [size]="20" />
        }
      </span>
      <span class="text-muted-foreground w-24 shrink-0 text-right text-xs whitespace-nowrap max-sm:hidden" [class.text-status-blocked]="overdue()">
        {{ p.targetDate ? (p.targetDate | fullDate) : '—' }}
      </span>
    </a>
  `,
})
export class ViewProjectRow extends ProjectItemBase {}

/** Board card: glyph + name, then priority, health and the target date. */
@Component({
  selector: 'app-view-project-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ActorAvatar, FullDatePipe, PriorityIcon, ProjectGlyph, ProjectHealthBadge],
  host: { class: 'block' },
  template: `
    @let p = project();
    <a
      [routerLink]="['/', slug(), 'projects', p.id]"
      [attr.data-row-id]="p.id"
      class="bg-card hover:border-foreground/25 block rounded-lg border p-2.5 transition-colors"
      [class.border-primary]="focused()"
    >
      <span class="flex items-center gap-2">
        <app-project-glyph [project]="p" [size]="16" />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{{ p.name }}</span>
        @if (p.leadId) {
          <app-actor-avatar [actor]="{ type: 'user', id: p.leadId }" [size]="18" />
        }
      </span>
      @if (p.summary) {
        <span class="text-muted-foreground mt-1 line-clamp-2 block text-xs leading-snug">{{ p.summary }}</span>
      }
      <span class="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <app-priority-icon [priority]="p.priority" />
        <span class="flex items-center gap-1.5 text-xs" [class]="status().text">
          <span class="size-2 shrink-0 rounded-full" [class]="status().dot"></span>{{ status().label }}
        </span>
        @if (p.health) {
          <app-project-health [health]="p.health" [compact]="true" />
        }
        @if (p.targetDate) {
          <span class="text-muted-foreground ml-auto text-[11px] whitespace-nowrap" [class.text-status-blocked]="overdue()">{{ p.targetDate | fullDate }}</span>
        }
      </span>
    </a>
  `,
})
export class ViewProjectCard extends ProjectItemBase {}
