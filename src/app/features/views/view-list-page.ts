import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChartGantt, LucideDynamicIcon, LucideKanban, LucideLayers, LucideList, LucideLock, LucidePlus, LucideUsers } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, UiStore, type SavedView } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { ENTITY_ICON, ENTITY_LABEL, describeFilters } from './view-model';

interface ViewSection {
  id: string;
  title: string;
  views: SavedView[];
}

/** Saved views, split into "Your views" and "Shared with the workspace". */
@Component({
  selector: 'app-view-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmTooltip, LucideDynamicIcon, PageHeader, Kbd, EmptyState, ActorAvatar, RelativeTimePipe, TopBarActions],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New view</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Views" [description]="description()" />

    @if (views().length === 0) {
      <app-empty-state
        [icon]="layers"
        title="No saved views"
        description="A view is a saved filter over issues, workstreams, projects or decisions, shown as a list, a board or (for workstreams and projects) a timeline. Private views stay yours; shared ones show up for everyone."
      >
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New view</button>
        }
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        @for (s of sections(); track s.id) {
          <div class="bg-muted/40 sticky top-0 z-10 flex h-8 items-center gap-2 border-b px-4 backdrop-blur sm:px-6">
            <span class="text-xs font-medium">{{ s.title }}</span>
            <span class="text-muted-foreground text-xs tabular-nums">{{ s.views.length }}</span>
          </div>
          @for (v of s.views; track v.id) {
            <a
              role="listitem"
              [routerLink]="['/', slug(), 'views', v.id]"
              [attr.data-row-id]="v.id"
              class="hover:bg-hover focus-visible:bg-hover focus-visible:ring-ring flex min-h-14 items-center gap-3 border-b px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-6 md:min-h-9 md:py-1.5"
              [class.bg-selected]="ui.focusedRowId() === v.id"
            >
              <svg
                [lucideIcon]="entityIcon(v)"
                [size]="14"
                [class]="v.entity === 'workstream' ? 'text-entity-workstream' : v.entity === 'decision' ? 'text-entity-decision' : v.entity === 'project' ? 'text-muted-foreground' : 'text-entity-issue'"
                class="shrink-0"
              ></svg>
              <span class="min-w-0 shrink truncate text-sm">{{ v.name }}</span>
              <span class="text-meta hidden min-w-0 flex-1 truncate md:inline">{{ summary(v) }}</span>
              <span class="flex-1 md:hidden"></span>
              <span class="text-meta w-20 shrink-0 max-sm:hidden">{{ entityLabel(v) }}</span>
              <svg
                [lucideIcon]="layoutIcon(v)"
                [size]="13"
                class="text-muted-foreground shrink-0"
                [hlmTooltip]="layoutLabel(v)"
                position="bottom"
              ></svg>
              <svg
                [lucideIcon]="v.shared ? usersIcon : lockIcon"
                [size]="13"
                class="text-muted-foreground shrink-0"
                [hlmTooltip]="v.shared ? 'Shared with the workspace' : 'Private to you'"
                position="bottom"
              ></svg>
              <app-actor-avatar [actor]="{ type: 'user', id: v.ownerId }" [size]="18" class="shrink-0" />
              <span class="text-meta w-24 shrink-0 text-end whitespace-nowrap tabular-nums max-sm:hidden">{{ v.updatedAt | relativeTime }}</span>
            </a>
          }
        }
      </div>
    }
  `,
})
export class ViewListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly plus = LucidePlus;
  protected readonly layers = LucideLayers;
  protected readonly listIcon = LucideList;
  protected readonly boardIcon = LucideKanban;
  protected readonly timelineIcon = LucideChartGantt;
  protected readonly usersIcon = LucideUsers;
  protected readonly lockIcon = LucideLock;
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly views = computed(() =>
    this.store.views().slice().sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly sections = computed<ViewSection[]>(() => {
    const me = this.store.me()?.id;
    const mine = this.views().filter((v) => v.ownerId === me);
    const shared = this.views().filter((v) => v.ownerId !== me);
    return [
      { id: 'mine', title: 'Your views', views: mine },
      { id: 'shared', title: 'Shared with the workspace', views: shared },
    ].filter((s) => s.views.length > 0);
  });
  protected readonly description = computed(() => {
    const n = this.views().length;
    return n === 1 ? '1 saved view' : `${n} saved views`;
  });

  protected layoutIcon(v: SavedView) {
    return v.layout === 'board' ? this.boardIcon : v.layout === 'timeline' ? this.timelineIcon : this.listIcon;
  }
  protected layoutLabel(v: SavedView): string {
    return v.layout === 'board' ? 'Board' : v.layout === 'timeline' ? 'Timeline' : 'List';
  }
  protected entityIcon(v: SavedView) {
    return ENTITY_ICON[v.entity];
  }
  protected entityLabel(v: SavedView): string {
    return ENTITY_LABEL[v.entity];
  }
  protected summary(v: SavedView): string {
    return describeFilters(this.store, v);
  }
  protected create(): void {
    this.ui.openCreate('view');
  }
}
