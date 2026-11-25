import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChartGantt, LucideDynamicIcon, LucideKanban, LucideLayers, LucideList, LucideLock, LucidePlus, LucideUsers } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, UiStore, type SavedView } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { V3NameAvatar } from './view-atoms';
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
  imports: [RouterLink, HlmButtonImports, HlmTooltip, LucideDynamicIcon, PageHeader, Kbd, EmptyState, V3NameAvatar, RelativeTimePipe, TopBarActions],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New view</span>
          <app-kbd keys="c" class="max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Views" [description]="description()" />

    @if (views().length === 0) {
      <app-empty-state
        [icon]="layers"
        title="No saved views"
        description="A view is a saved filter over tasks or projects, shown as a list, a board or timeline. Private views stay yours; shared ones show up for everyone."
      >
        @if (canEdit()) {
          <button hlmBtn (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New view</button>
        }
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto pb-6" role="list">
        @for (s of sections(); track s.id) {
          <div
            class="border-border bg-background text-faint sticky top-0 z-10 flex h-8 items-center gap-2 border-b px-4 font-mono text-[10px] tracking-[1px] uppercase sm:px-6"
          >
            <span>{{ s.title }}</span>
            <span class="tracking-normal tabular-nums">{{ s.views.length }}</span>
          </div>
          @for (v of s.views; track v.id) {
            <a
              role="listitem"
              [routerLink]="['/', slug(), 'views', v.id]"
              [attr.data-row-id]="v.id"
              class="border-border hover:bg-hover focus-visible:bg-selected flex min-h-14 items-center gap-3 border-b px-4 py-2 outline-none sm:px-6 md:h-10 md:min-h-10 md:py-0"
              [class.bg-selected]="ui.focusedRowId() === v.id"
            >
              <svg
                [lucideIcon]="entityIcon(v)"
                [size]="14"
                class="text-muted-foreground shrink-0"
                aria-hidden="true"
              ></svg>
              <span class="text-foreground min-w-0 shrink truncate text-[13.5px]">{{ v.name }}</span>
              <span class="text-faint hidden min-w-0 flex-1 truncate font-mono text-[11px] md:inline">{{
                summary(v)
              }}</span>
              <span class="flex-1 md:hidden"></span>
              <span class="text-muted-foreground w-16 shrink-0 font-mono text-[11px] max-sm:hidden">{{
                entityLabel(v)
              }}</span>
              <span
                class="border-border text-muted-foreground inline-flex shrink-0 items-center gap-1.5 border px-2 py-0.5 font-mono text-[10.5px] leading-[14px]"
                [hlmTooltip]="'Layout: ' + layoutLabel(v)"
                position="bottom"
              >
                <svg [lucideIcon]="layoutIcon(v)" [size]="11" aria-hidden="true"></svg>
                {{ layoutLabel(v) }}
              </span>
              <span
                class="inline-flex w-[72px] shrink-0 items-center gap-1.5 font-mono text-[10.5px] leading-[14px] max-md:hidden"
                [class]="v.shared ? 'text-delta' : 'text-faint'"
                [hlmTooltip]="v.shared ? 'Shared with the workspace' : 'Private to you'"
                position="bottom"
              >
                <svg [lucideIcon]="v.shared ? usersIcon : lockIcon" [size]="11" aria-hidden="true"></svg>
                {{ v.shared ? 'Shared' : 'Private' }}
              </span>
              <v3-name-avatar [name]="ownerName(v)" [size]="20" class="max-sm:hidden" />
              <span
                class="text-faint w-24 shrink-0 text-right font-mono text-[11px] whitespace-nowrap max-sm:hidden"
                >{{ v.updatedAt | relativeTime }}</span
              >
            </a>
          }
        }
      </div>
    }
  `,
})
export class ViewListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(TramaStore);
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
    this.store
      .views()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
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
  protected ownerName(v: SavedView): string {
    return this.store.getUser(v.ownerId)?.name ?? 'Unknown';
  }
  protected summary(v: SavedView): string {
    return describeFilters(this.store, v);
  }
  protected create(): void {
    this.ui.openCreate('view');
  }
}
