// Project rows and board cards for saved views over projects: glyph, name, priority, status,
// health, lead and target date. The whole row/card is a link to the project page.
import { ChangeDetectionStrategy, Component, Directive, computed, inject, input } from '@angular/core';
import { TramaStore, UiStore, type Project } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { PreviewLink } from '../issues/list-preview';
import { ActorAvatar } from '../../shared/actor-avatar';
import { FullDatePipe } from '../../shared/pipes';
import { PriorityIcon } from '../../shared/priority-icon';
import { ProjectGlyph } from '../projects/project-glyph';
import { PROJECT_STATUS_META, isOverdue } from '../projects/project-model';

@Directive()
abstract class ProjectItemBase {
  protected readonly store = inject(TramaStore);
  readonly project = input.required<Project>();
  readonly focused = input(false);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly status = computed(() => PROJECT_STATUS_META[this.project().status]);
  protected readonly overdue = computed(() => isOverdue(this.project()));

  private readonly pane = inject(RightPaneStore);
  private readonly ui = inject(UiStore);
  /** The right pane shows this project. */
  protected readonly previewed = computed(() => {
    const c = this.pane.content();
    return c?.kind === 'project' && c.id === this.project().id;
  });

  /** A single click previews the project; Enter, a double click and phones open it. */
  protected preview(): void {
    this.ui.setFocusedRow(this.project().id);
    this.pane.show({ kind: 'project', id: this.project().id });
  }
}

/** One dense list row: glyph · name · priority · status · lead · target date. */
@Component({
  selector: 'app-view-project-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PreviewLink, ActorAvatar, FullDatePipe, PriorityIcon, ProjectGlyph],
  host: { class: 'block' },
  template: `
    @let p = project();
    <a
      [appPreviewLink]="['/', slug(), 'projects', p.id]"
      (preview)="preview()"
      [attr.data-row-id]="p.id"
      class="hover:bg-hover focus-visible:bg-hover flex min-h-9 items-center gap-3 px-4 py-1.5 text-[13px] outline-none sm:px-5"
      [class.bg-selected]="focused() || previewed()"
    >
      <app-project-glyph [project]="p" [size]="16" />
      <span class="min-w-0 flex-1 truncate" [class.text-muted-foreground]="p.status === 'canceled'">{{ p.name }}</span>
      <app-priority-icon [priority]="p.priority" class="max-md:hidden" />
      <span class="flex w-28 shrink-0 items-center gap-1.5 text-xs max-sm:hidden" [class]="status().text">
        <span class="size-2 shrink-0 rounded-full" [class]="status().dot"></span>{{ status().label }}
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

/** Board card: glyph + name, then priority and the target date. */
@Component({
  selector: 'app-view-project-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PreviewLink, ActorAvatar, FullDatePipe, PriorityIcon, ProjectGlyph],
  host: { class: 'block' },
  template: `
    @let p = project();
    <a
      [appPreviewLink]="['/', slug(), 'projects', p.id]"
      (preview)="preview()"
      [attr.data-row-id]="p.id"
      class="block rounded-lg p-2.5 transition-colors"
      [class]="focused() || previewed() ? 'bg-selected' : 'bg-background hover:bg-hover'"
    >
      <span class="flex items-center gap-2">
        <app-project-glyph [project]="p" [size]="16" />
        <span class="min-w-0 flex-1 truncate text-[13px]">{{ p.name }}</span>
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
        @if (p.targetDate) {
          <span class="text-muted-foreground ml-auto text-[11px] whitespace-nowrap" [class.text-status-blocked]="overdue()">{{ p.targetDate | fullDate }}</span>
        }
      </span>
    </a>
  `,
})
export class ViewProjectCard extends ProjectItemBase {}
