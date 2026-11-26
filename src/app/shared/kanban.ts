// One drag-and-drop board for issue lists (v3): grouped rows with 30px headers, or columns of cards.
import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Directive,
  ElementRef,
  TemplateRef,
  computed,
  contentChild,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LucideChevronDown, LucideChevronRight, LucideDynamicIcon, LucidePlus } from '@lucide/angular';

export interface KanbanColumn<T> {
  key: string;
  items: readonly T[];
  /** Number shown in the group header when it differs from the items (context rows are not counted). */
  count?: number;
}

/** A group as the template draws it: the part of `all` that is in the DOM, and the room of what is not. */
interface KanbanView<T> {
  key: string;
  count: number;
  all: readonly T[];
  items: readonly T[];
  /** List layout: pixels standing in for the rows above / below the rendered ones. */
  padTop: number;
  padBottom: number;
  /** Board layout: cards are left, the column loads them as it scrolls. */
  more: boolean;
}

/** Cards a board column draws at first; the next batch follows when the column is scrolled near its end. */
const COLUMN_BATCH = 24;
/** Height of a group header in the list layout, and of an empty group. */
const GROUP_HEADER_PX = 30.5;
const EMPTY_GROUP_PX = 24;
/** The list draws the rows within this many pixels of the viewport, in steps of `WINDOW_STEP`. */
const WINDOW_BUFFER_PX = 640;
const WINDOW_STEP_PX = 160;
/** Viewport guess until the scroller is measured (one screen plus the buffer). */
const INITIAL_BOTTOM_PX = 1600;

/** Largest index `i` with `prefix[i] <= value` (0 when `value` is before the first). `prefix` ascends. */
function lastAtOrBefore(prefix: Float64Array, value: number): number {
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Smallest index `i` with `prefix[i] >= value` (the last index when `value` is beyond the end). */
function firstAtOrAfter(prefix: Float64Array, value: number): number {
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] >= value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Emits `reached` while the element is within reach of the end of its scroll parent. */
@Directive({ selector: '[kanbanSentinel]' })
export class KanbanSentinel {
  readonly reached = output<void>();

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const root = el.parentElement;
    if (typeof IntersectionObserver === 'undefined' || !root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        this.reached.emit();
        // Look again once the batch is drawn: still in reach means one more.
        observer.unobserve(el);
        timer = setTimeout(() => observer.observe(el), 60);
      },
      { root, rootMargin: '0px 0px 800px 0px' },
    );
    observer.observe(el);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(timer);
      observer.disconnect();
    });
  }
}

export interface KanbanMove<T> {
  item: T;
  to: string;
}

@Directive({ selector: 'ng-template[kanbanItem]' })
export class KanbanItemDirective<T> {
  constructor(readonly template: TemplateRef<{ $implicit: T }>) {}
}

@Directive({ selector: 'ng-template[kanbanLabel]' })
export class KanbanLabelDirective {
  constructor(readonly template: TemplateRef<{ $implicit: string }>) {}
}

@Component({
  selector: 'app-kanban',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, CdkDropListGroup, CdkDropList, CdkDrag, LucideDynamicIcon, KanbanSentinel],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  styles: `
    .board-column {
      contain: layout style;
    }

    .board-item {
      content-visibility: auto;
      contain-intrinsic-block-size: auto 120px;
    }

    /* The preview is rendered outside the scrollport: keep it fully rendered. Cards of the lists stay
       skippable while dragging (the lists never sort, only their container geometry is read), so a drag
       does not lay out every card of a column. */
    .board-item.cdk-drag-preview,
    .board-item:focus-within {
      content-visibility: visible;
    }

    /* v3: the card in hand is tilted with a blue outline; the one left behind fades. */
    .board-item.cdk-drag-preview {
      rotate: 1deg;
      outline: 1px solid var(--delta-line);
      box-shadow: 0 12px 32px rgb(0 0 0 / 0.6);
    }
    .board-item.cdk-drag-placeholder {
      opacity: 0.4;
    }
  `,
  template: `
    @if (layout() === 'list') {
      <div
        #scroller
        class="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        role="list"
        cdkDropListGroup
        (scroll)="syncWindow()"
      >
        @for (g of listView(); track g.key) {
          <section>
            <div class="group/gh bg-card border-border sticky top-0 z-[2] flex h-[30.5px] items-center border-b pr-[10px]">
              <button
                type="button"
                class="flex h-full min-w-0 flex-1 items-center gap-2.5 px-4 text-left outline-none focus-visible:underline"
                [attr.aria-expanded]="!collapsed().has(g.key)"
                (click)="toggle(g.key)"
              >
                <svg [lucideIcon]="collapsed().has(g.key) ? right : down" [size]="13" class="text-faint shrink-0"></svg>
                <span class="text-foreground flex min-w-0 items-center gap-2.5 font-mono text-[11.5px]">
                  <ng-container *ngTemplateOutlet="label().template; context: { $implicit: g.key }" />
                </span>
                <span class="text-faint font-mono text-[11px] tabular-nums">{{ g.count }}</span>
              </button>
              @if (addable()) {
                <button
                  type="button"
                  class="text-faint hover:text-foreground hover:bg-hover flex size-6 items-center justify-center outline-none focus-visible:text-foreground"
                  [attr.aria-label]="addLabel()"
                  [title]="addLabel()"
                  (click)="add.emit(g.key)"
                >
                  <svg [lucideIcon]="plus" [size]="13"></svg>
                </button>
              }
            </div>
            @if (!collapsed().has(g.key)) {
              <div
                cdkDropList
                [id]="listId(g.key)"
                [cdkDropListData]="g.all"
                [cdkDropListDisabled]="disabled()"
                cdkDropListSortingDisabled
                class="min-h-6 transition-colors"
                [class]="over() === g.key && from() !== g.key ? 'bg-delta-line/5' : ''"
                [style.padding-top.px]="g.padTop || null"
                [style.padding-bottom.px]="g.padBottom || null"
                (cdkDropListEntered)="over.set(g.key)"
                (cdkDropListExited)="over.set(null)"
                (cdkDropListDropped)="drop($event)"
              >
                @for (item of g.items; track track()(item)) {
                  <div
                    cdkDrag
                    [cdkDragData]="item"
                    [cdkDragDisabled]="disabled()"
                    [cdkDragStartDelay]="touchDelay"
                    (cdkDragStarted)="from.set(g.key)"
                    (cdkDragEnded)="endDrag()"
                  >
                    <ng-container *ngTemplateOutlet="items().template; context: { $implicit: item }" />
                  </div>
                }
              </div>
            }
          </section>
        }
      </div>
    } @else {
      <!-- Phones: one column per screen, swipe sideways between them (scroll-snap). -->
      <div class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden max-md:snap-x max-md:snap-mandatory max-md:scroll-px-4">
        <div class="flex h-full gap-3 px-4 py-4 sm:px-5 max-md:min-w-max" cdkDropListGroup>
          @for (g of boardView(); track g.key) {
            <section class="board-column group/col flex h-full min-w-[13.75rem] flex-1 basis-0 flex-col gap-2 max-md:w-[calc(100vw-3rem)] max-md:flex-none max-md:snap-start">
              <header class="flex shrink-0 items-center gap-2 px-0.5 pt-1 pb-2">
                <span class="text-foreground flex min-w-0 items-center gap-2 font-mono text-[11.5px] leading-[15px]">
                  <ng-container *ngTemplateOutlet="label().template; context: { $implicit: g.key }" />
                </span>
                <span class="text-faint font-mono text-[11px] leading-[15px] tabular-nums">{{ g.count }}</span>
                <span class="flex-1"></span>
                @if (addable()) {
                  <button
                    type="button"
                    class="text-faint hover:text-foreground hover:bg-hover -mr-[3.5px] -my-[3px] flex size-5 items-center justify-center outline-none focus-visible:text-foreground"
                    [attr.aria-label]="addLabel()"
                    [title]="addLabel()"
                    (click)="add.emit(g.key)"
                  >
                    <svg [lucideIcon]="plus" [size]="13"></svg>
                  </button>
                }
              </header>
              <div
                cdkDropList
                [id]="listId(g.key)"
                [cdkDropListData]="g.all"
                [cdkDropListDisabled]="disabled()"
                cdkDropListSortingDisabled
                class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
                (cdkDropListEntered)="over.set(g.key)"
                (cdkDropListExited)="over.set(null)"
                (cdkDropListDropped)="drop($event)"
              >
                @for (item of g.items; track track()(item)) {
                  <div
                    class="board-item shrink-0"
                    cdkDrag
                    [cdkDragData]="item"
                    [cdkDragDisabled]="disabled()"
                    [cdkDragStartDelay]="touchDelay"
                    [class.cursor-grab]="!disabled()"
                    (cdkDragStarted)="from.set(g.key)"
                    (cdkDragEnded)="endDrag()"
                  >
                    <ng-container *ngTemplateOutlet="items().template; context: { $implicit: item }" />
                  </div>
                } @empty {
                  @if (over() !== g.key) {
                    <p class="text-faint px-1 py-5 text-center font-mono text-[11px]">{{ emptyText() }}</p>
                  }
                }
                @if (g.more) {
                  <div class="h-px shrink-0" aria-hidden="true" kanbanSentinel (reached)="loadMore(g.key)"></div>
                }
                @if (over() === g.key && from() !== g.key) {
                  <div
                    class="border-delta-line bg-delta-line/8 text-delta flex h-[60px] shrink-0 items-center justify-center border font-mono text-[11px]"
                    aria-hidden="true"
                  >
                    {{ dropText()(g.key) }}
                  </div>
                }
              </div>
            </section>
          }
        </div>
      </div>
    }
  `,
})
export class Kanban<T> {
  readonly columns = input.required<readonly KanbanColumn<T>[]>();
  readonly layout = input<'list' | 'board'>('board');
  readonly disabled = input(false);
  /** Touch drags start after a short hold so swiping and scrolling keep working. */
  protected readonly touchDelay = { touch: 280, mouse: 0 };
  /** Drop-list id prefix, unique per board on the page. */
  readonly prefix = input('kanban');
  readonly track = input<(item: T) => string>((item) => String((item as { id?: string }).id ?? ''));
  readonly moved = output<KanbanMove<T>>();
  /** Show a "+" in each group header; emits the group key. */
  readonly addable = input(false);
  readonly addLabel = input('Add');
  readonly add = output<string>();
  /** Placeholder of an empty board column. */
  readonly emptyText = input('Drop here');
  /** What the drop target of a column says while a card is over it ("Drop to set In review"). */
  readonly dropText = input<(key: string) => string>(() => 'Drop here');

  /**
   * List layout: height in pixels of an item when every row has a known height. With it the list only draws
   * the rows near the viewport (the others are room in the group's padding); without it every row is drawn.
   */
  readonly rowHeight = input<((item: T) => number) | null>(null);

  private readonly items = contentChild.required(KanbanItemDirective<T>);
  private readonly label = contentChild.required(KanbanLabelDirective);
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Group key of the column / section the dragged card is over, and the one it came from. */
  protected readonly over = signal<string | null>(null);
  protected readonly from = signal<string | null>(null);
  protected readonly down = LucideChevronDown;
  protected readonly right = LucideChevronRight;
  protected readonly plus = LucidePlus;

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** Scroll range (in pixels of the list's content) whose rows are drawn. */
  private readonly win = signal({ top: 0, bottom: INITIAL_BOTTOM_PX });
  /** Cards drawn per board column (`COLUMN_BATCH` until the column asked for more). */
  private readonly columnLimits = signal<ReadonlyMap<string, number>>(new Map());

  /** Where each group starts and how tall its rows are, only recomputed when the groups change. */
  private readonly metrics = computed(() => {
    const heightOf = this.rowHeight();
    if (!heightOf) return null;
    const collapsed = this.collapsed();
    let offset = 0;
    return this.columns().map((g) => {
      const top = offset + GROUP_HEADER_PX;
      if (collapsed.has(g.key)) {
        offset = top;
        return { top, prefix: new Float64Array(1) };
      }
      const prefix = new Float64Array(g.items.length + 1);
      for (let i = 0; i < g.items.length; i++) prefix[i + 1] = prefix[i] + heightOf(g.items[i]);
      offset = top + Math.max(prefix[g.items.length], EMPTY_GROUP_PX);
      return { top, prefix };
    });
  });

  protected readonly listView = computed<KanbanView<T>[]>(() => {
    const cols = this.columns();
    const metrics = this.metrics();
    const collapsed = this.collapsed();
    const win = this.win();
    return cols.map((g, index) => {
      const view = { key: g.key, count: g.count ?? g.items.length, all: g.items, more: false };
      const m = metrics?.[index];
      if (!m || collapsed.has(g.key)) return { ...view, items: g.items, padTop: 0, padBottom: 0 };
      const { prefix, top } = m;
      const n = g.items.length;
      const start = lastAtOrBefore(prefix, win.top - top);
      const end = Math.max(start, firstAtOrAfter(prefix, win.bottom - top));
      return {
        ...view,
        items: start === 0 && end === n ? g.items : g.items.slice(start, end),
        padTop: prefix[start],
        padBottom: prefix[n] - prefix[end],
      };
    });
  });

  protected readonly boardView = computed<KanbanView<T>[]>(() => {
    const limits = this.columnLimits();
    return this.columns().map((g) => {
      const limit = limits.get(g.key) ?? COLUMN_BATCH;
      const more = g.items.length > limit;
      return {
        key: g.key,
        count: g.count ?? g.items.length,
        all: g.items,
        items: more ? g.items.slice(0, limit) : g.items,
        padTop: 0,
        padBottom: 0,
        more,
      };
    });
  });

  constructor() {
    // Measure the list: the rows to draw follow its size and, below, its scroll position.
    effect((onCleanup) => {
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      untracked(() => this.syncWindow());
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.syncWindow());
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });
  }

  /** Move the drawn range to the scroll position (not while a row is held: it must stay in the DOM). */
  protected syncWindow(): void {
    const el = this.scroller()?.nativeElement;
    if (!el || this.from() !== null) return;
    const top = Math.max(0, Math.floor((el.scrollTop - WINDOW_BUFFER_PX) / WINDOW_STEP_PX) * WINDOW_STEP_PX);
    const bottom =
      Math.ceil((el.scrollTop + (el.clientHeight || 800) + WINDOW_BUFFER_PX) / WINDOW_STEP_PX) * WINDOW_STEP_PX;
    const now = this.win();
    if (top !== now.top || bottom !== now.bottom) this.win.set({ top, bottom });
  }

  protected loadMore(key: string): void {
    this.columnLimits.update((m) => new Map(m).set(key, (m.get(key) ?? COLUMN_BATCH) + COLUMN_BATCH));
  }

  protected listId(key: string): string {
    return `${this.prefix()}:${key}`;
  }

  protected toggle(key: string): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  protected endDrag(): void {
    this.over.set(null);
    this.from.set(null);
    this.syncWindow();
  }

  protected drop(event: CdkDragDrop<readonly T[]>): void {
    this.endDrag();
    if (this.disabled() || event.previousContainer === event.container) return;
    const item = event.item.data as T | undefined;
    if (!item) return;
    const to = event.container.id.slice(this.prefix().length + 1);
    this.moved.emit({ item, to });
  }
}
