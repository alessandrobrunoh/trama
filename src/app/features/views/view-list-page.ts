import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideLayers, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NablaStore, UiStore, type ViewEntity } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';

const ENTITY_LABEL: Record<ViewEntity, string> = {
  workstream: 'Workstreams',
  issue: 'Issues',
  decision: 'Decisions',
};

@Component({
  selector: 'app-view-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, LucideDynamicIcon, PageHeader, Kbd, EmptyState, RelativeTimePipe, TopBarActions],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New view</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Views" [description]="description()" />

    @if (views().length === 0) {
      <app-empty-state [icon]="layers" title="No saved views" description="Filter a list of workstreams and choose Save view. Private views stay yours; shared ones are visible to the workspace.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New view</button>
        }
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        @for (v of views(); track v.id) {
          <a
            [routerLink]="['/', slug(), 'views', v.id]"
            [attr.data-row-id]="v.id"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 outline-none sm:px-6"
            [class.bg-muted]="ui.focusedRowId() === v.id"
          >
            <svg [lucideIcon]="layers" [size]="15" class="text-muted-foreground shrink-0"></svg>
            <span class="min-w-0 flex-1 truncate text-sm">{{ v.name }}</span>
            <span class="text-muted-foreground text-xs">{{ entityLabel(v.entity) }}</span>
            <span class="text-muted-foreground text-xs">{{ v.filters.length }} filter{{ v.filters.length === 1 ? '' : 's' }}</span>
            <span class="text-muted-foreground text-xs">{{ v.shared ? 'Shared' : 'Private' }}</span>
            <span class="text-muted-foreground hidden text-xs sm:inline">{{ v.updatedAt | relativeTime }}</span>
          </a>
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
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly views = computed(() =>
    this.store.views().slice().sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly description = computed(() => {
    const n = this.views().length;
    return n === 1 ? '1 saved view' : `${n} saved views`;
  });

  protected entityLabel(entity: ViewEntity): string {
    return ENTITY_LABEL[entity];
  }
  protected create(): void {
    this.ui.openCreate('view');
  }
}
