// One drag-and-drop board for issue lists (v3): grouped rows with 30px headers, or columns of cards.
import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, Directive, TemplateRef, contentChild, input, output, signal } from '@angular/core';
import { LucideChevronDown, LucideChevronRight, LucideDynamicIcon, LucidePlus } from '@lucide/angular';

export interface KanbanColumn<T> {
  key: string;
  items: readonly T[];
  /** Number shown in the group header when it differs from the items (context rows are not counted). */
  count?: number;
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
  imports: [NgTemplateOutlet, CdkDropListGroup, CdkDropList, CdkDrag, LucideDynamicIcon],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  styles: `
    .board-column {
      contain: layout style;
    }

    .board-item {
      content-visibility: auto;
      contain-intrinsic-block-size: auto 120px;
    }

    /* CDK measures every card when dragging. Use real geometry, not offscreen
       estimates, and keep the preview fully rendered outside the scrollport. */
    .cdk-drop-list-dragging .board-item,
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
      <div class="min-h-0 flex-1 overflow-y-auto" role="list" cdkDropListGroup>
        @for (g of columns(); track g.key) {
          <section>
            <div class="group/gh bg-card border-border sticky top-0 z-[2] flex h-[30.5px] items-center border-b pr-3 sm:pr-4">
              <button
                type="button"
                class="flex h-full min-w-0 flex-1 items-center gap-2.5 px-4 text-left outline-none focus-visible:underline"
                [attr.aria-expanded]="!collapsed().has(g.key)"
                (click)="toggle(g.key)"
              >
                <svg [lucideIcon]="collapsed().has(g.key) ? right : down" [size]="12" class="text-faint shrink-0"></svg>
                <span class="text-foreground flex min-w-0 items-center gap-2.5 font-mono text-[11.5px]">
                  <ng-container *ngTemplateOutlet="label().template; context: { $implicit: g.key }" />
                </span>
                <span class="text-faint font-mono text-[11px] tabular-nums">{{ g.count ?? g.items.length }}</span>
              </button>
              @if (addable()) {
                <button
                  type="button"
                  class="text-faint hover:text-foreground hover:bg-hover flex size-6 items-center justify-center outline-none focus-visible:text-foreground"
                  [attr.aria-label]="addLabel()"
                  [title]="addLabel()"
                  (click)="add.emit(g.key)"
                >
                  <svg [lucideIcon]="plus" [size]="14"></svg>
                </button>
              }
            </div>
            @if (!collapsed().has(g.key)) {
              <div
                cdkDropList
                [id]="listId(g.key)"
                [cdkDropListData]="g.items"
                [cdkDropListDisabled]="disabled()"
                cdkDropListSortingDisabled
                class="min-h-6 transition-colors"
                [class]="over() === g.key && from() !== g.key ? 'bg-delta-line/5' : ''"
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
          @for (g of columns(); track g.key) {
            <section class="board-column group/col flex h-full min-w-[13.75rem] flex-1 basis-0 flex-col gap-2 max-md:w-[calc(100vw-3rem)] max-md:flex-none max-md:snap-start">
              <header class="flex shrink-0 items-center gap-2 px-0.5 pt-1 pb-2">
                <span class="text-foreground flex min-w-0 items-center gap-2 font-mono text-[11.5px]">
                  <ng-container *ngTemplateOutlet="label().template; context: { $implicit: g.key }" />
                </span>
                <span class="text-faint font-mono text-[11px] tabular-nums">{{ g.count ?? g.items.length }}</span>
                <span class="flex-1"></span>
                @if (addable()) {
                  <button
                    type="button"
                    class="text-faint hover:text-foreground hover:bg-hover flex size-5 items-center justify-center outline-none focus-visible:text-foreground"
                    [attr.aria-label]="addLabel()"
                    [title]="addLabel()"
                    (click)="add.emit(g.key)"
                  >
                    <svg [lucideIcon]="plus" [size]="14"></svg>
                  </button>
                }
              </header>
              <div
                cdkDropList
                [id]="listId(g.key)"
                [cdkDropListData]="g.items"
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

  private readonly items = contentChild.required(KanbanItemDirective<T>);
  private readonly label = contentChild.required(KanbanLabelDirective);
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Group key of the column / section the dragged card is over, and the one it came from. */
  protected readonly over = signal<string | null>(null);
  protected readonly from = signal<string | null>(null);
  protected readonly down = LucideChevronDown;
  protected readonly right = LucideChevronRight;
  protected readonly plus = LucidePlus;

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
