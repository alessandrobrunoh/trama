import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import {
  LucideArrowLeft,
  LucideDynamicIcon,
  LucideMousePointerClick,
  LucideMaximize2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  RIGHT_PANE_MAX_WIDTH,
  RIGHT_PANE_MIN_WIDTH,
  RightPaneStore,
} from '../core/stores/right-pane.store';
import { TramaStore } from '../core/stores/trama.store';
import { Viewport } from '../core/viewport';
import { TaskInspector } from '../features/issues/task-inspector';
import { ProjectPreview } from '../features/projects/project-preview';
import { Kbd } from '../shared/kbd';
import { PageChrome } from './page-chrome';

/** Sections whose pages feed the pane (preview of the selected row); elsewhere the pane is not drawn. */
export const PANE_SECTIONS: ReadonlySet<string> = new Set([
  'inbox',
  'overview',
  'board',
  'timeline',
  'tasks',
  'issues',
  'projects',
  'views',
]);

/**
 * The contextual right pane of the shell: an inspector for whatever `RightPaneStore.content()` holds
 * (a task or a project). Light-gray surface, a hairline on its left edge, its own slim header row
 * (tabs on the left, icon actions on the right). Desktop: fixed width, drag the edge (or use the
 * arrow keys on it) to resize; below 1024px it floats over the page. Phones: a bottom sheet.
 * Page-specific tabs / actions come from `<ng-template appRightPaneTabs|appRightPaneActions>`.
 */
@Component({
  selector: 'app-right-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmTooltip,
    Kbd,
    TaskInspector,
    ProjectPreview,
  ],
  host: { class: 'contents' },
  template: `
    @if (viewport.isMobile()) {
      @if (pane.mobileOpen()) {
        <button
          type="button"
          class="fixed inset-0 z-40 bg-black/40"
          aria-label="Close preview"
          tabindex="-1"
          (click)="pane.close()"
        ></button>
        <aside
          class="bg-sidebar text-foreground animate-in slide-in-from-bottom fixed inset-x-0 bottom-0 z-[45] flex h-[88dvh] flex-col overflow-hidden rounded-t-2xl shadow-menu duration-200"
          aria-label="Preview"
          (keydown.escape)="pane.close()"
        >
          <ng-container *ngTemplateOutlet="inner" />
        </aside>
      }
    } @else if (pane.open() && visible()) {
      <aside
        class="bg-sidebar text-foreground border-border relative flex h-svh min-h-0 shrink-0 flex-col border-s max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:max-w-[85vw] max-lg:shadow-menu"
        [style.width.px]="pane.width()"
        aria-label="Preview"
        data-testid="right-pane"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview"
          [attr.aria-valuenow]="pane.width()"
          [attr.aria-valuemin]="min"
          [attr.aria-valuemax]="max"
          tabindex="0"
          class="hover:bg-primary/30 focus-visible:bg-primary/40 active:bg-primary/40 absolute inset-y-0 -left-[3px] z-10 w-[5px] cursor-col-resize touch-none outline-none transition-colors"
          (pointerdown)="startResize($event)"
          (keydown)="resizeByKey($event)"
        ></div>
        <ng-container *ngTemplateOutlet="inner" />
      </aside>
    }

    <ng-template #inner>
      <header class="border-border flex h-11 shrink-0 items-stretch border-b">
        <div class="flex min-w-0 flex-1 items-stretch" role="tablist" aria-label="Preview sections">
          @if (chrome.rightPaneTabs(); as tabs) {
            <ng-container *ngTemplateOutlet="tabs" />
          } @else {
            <span
              role="tab"
              aria-selected="true"
              class="bg-background border-border -mb-px flex min-w-0 items-center border-e px-4 text-[13px]"
              >{{ tabLabel() }}</span
            >
          }
        </div>
        <div class="flex shrink-0 items-center gap-0.5 px-1.5">
          @if (pane.overridesPage()) {
            <button
              hlmBtn
              variant="ghost"
              size="sm"
              class="text-muted-foreground gap-1"
              (click)="pane.clear()"
            >
              <svg [lucideIcon]="backIcon" [size]="13"></svg>Back
            </button>
          }
          @if (chrome.rightPaneActions(); as actions) {
            <ng-container *ngTemplateOutlet="actions" />
          }
          @if (fullLink(); as link) {
            <a
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground"
              [routerLink]="link"
              hlmTooltip="Open full page"
              position="bottom"
              aria-label="Open full page"
            >
              <svg [lucideIcon]="expandIcon" [size]="15"></svg>
            </a>
          }
          <button
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            hlmTooltip="Close preview  ⌘."
            position="bottom"
            aria-label="Close preview"
            (click)="pane.close()"
          >
            <svg [lucideIcon]="closeIcon" [size]="15"></svg>
          </button>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-safe">
        @switch (content()?.kind) {
          @case ('task') {
            @if (taskKey(); as key) {
              <app-task-inspector [idOrKey]="key" mode="preview" />
            }
          }
          @case ('project') {
            @if (projectId(); as id) {
              <app-project-preview [id]="id" [page]="ownedByPage()" />
            }
          }
          @default {
            <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[13px]">
              <svg [lucideIcon]="pointerIcon" [size]="20" class="opacity-60"></svg>
              <p>Select a task or project to see it here.</p>
              <p class="flex items-center gap-1.5 text-xs">Toggle this pane <app-kbd keys="mod+." /></p>
            </div>
          }
        }
      </div>
    </ng-template>
  `,
})
export class RightPane {
  protected readonly pane = inject(RightPaneStore);
  protected readonly viewport = inject(Viewport);
  protected readonly chrome = inject(PageChrome);
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);

  protected readonly min = RIGHT_PANE_MIN_WIDTH;
  protected readonly max = RIGHT_PANE_MAX_WIDTH;
  protected readonly closeIcon = LucideX;
  protected readonly expandIcon = LucideMaximize2;
  protected readonly pointerIcon = LucideMousePointerClick;
  protected readonly backIcon = LucideArrowLeft;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  protected readonly content = this.pane.content;
  /**
   * Pages that never put anything in the pane (settings, stats, timer…) don't show an empty one:
   * the pane is drawn on the sections that feed it (inbox, tasks, projects, views).
   */
  protected readonly visible = computed(() => {
    const section = this.url().split(/[?#]/)[0].split('/').filter(Boolean)[1];
    return section !== undefined && PANE_SECTIONS.has(section);
  });
  protected readonly taskKey = computed(() => {
    const c = this.content();
    return c?.kind === 'task' ? c.idOrKey : null;
  });
  protected readonly projectId = computed(() => {
    const c = this.content();
    return c?.kind === 'project' ? c.id : null;
  });
  protected readonly tabLabel = computed(() => {
    switch (this.content()?.kind) {
      case 'task':
        return 'Details';
      case 'project':
        return 'Details';
      default:
        return 'Preview';
    }
  });
  /** The content is the open page's own (the project page's properties), not a selection. */
  protected readonly ownedByPage = computed(() => {
    const c = this.content();
    return c !== null && c === this.pane.pageContent();
  });
  /** Router commands of the full page for the current content. */
  protected readonly fullLink = computed<readonly string[] | null>(() => {
    const c = this.content();
    const slug = this.store.slug();
    if (!c || !slug || this.ownedByPage()) return null;
    if (c.kind === 'task') return ['/', slug, 'tasks', this.store.getIssue(c.idOrKey)?.key ?? c.idOrKey];
    return ['/', slug, 'projects', c.id];
  });

  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = this.pane.width();
    const move = (e: PointerEvent): void => this.pane.setWidth(startWidth + (startX - e.clientX));
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  protected resizeByKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') this.pane.setWidth(this.pane.width() + step);
    else if (event.key === 'ArrowRight') this.pane.setWidth(this.pane.width() - step);
    else return;
    event.preventDefault();
  }
}
