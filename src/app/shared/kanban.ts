// One drag-and-drop board, shared by issues and workstreams.
import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, Directive, TemplateRef, contentChild, input, output, signal } from '@angular/core';
import { LucideChevronDown, LucideChevronRight, LucideDynamicIcon, LucidePlus } from '@lucide/angular';

export interface KanbanColumn<T> {
  key: string;
  items: readonly T[];
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
  template: `
    @if (layout() === 'list') {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list" cdkDropListGroup>
        @for (g of columns(); track g.key) {
          <section>
            <div class="group/gh bg-muted/40 hover:bg-muted/60 sticky top-0 z-[2] flex min-h-9 items-center border-b pr-2 sm:pr-4">
              <button
                type="button"
                class="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-4 text-left text-[13px] outline-none sm:px-6"
                [attr.aria-expanded]="!collapsed().has(g.key)"
                (click)="toggle(g.key)"
              >
                <svg [lucideIcon]="collapsed().has(g.key) ? right : down" [size]="13" class="text-muted-foreground shrink-0"></svg>
                <ng-container *ngTemplateOutlet="label().template; context: { $implicit: g.key }" />
                <span class="text-muted-foreground text-xs tabular-nums">{{ g.items.length }}</span>
              </button>
              @if (addable()) {
                <button
                  type="button"
                  class="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 items-center justify-center rounded-md opacity-0 group-hover/gh:opacity-100 focus-visible:opacity-100"
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
                class="min-h-8"
                (cdkDropListDropped)="drop($event)"
              >
                @for (item of g.items; track track()(item)) {
                  <div cdkDrag [cdkDragData]="item" [cdkDragDisabled]="disabled()">
                    <ng-container *ngTemplateOutlet="items().template; context: { $implicit: item }" />
                  </div>
                }
              </div>
            }
          </section>
        }
      </div>
    } @else {
      <div class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div class="flex h-full min-w-max gap-3 px-4 py-3 sm:px-6" cdkDropListGroup>
          @for (g of columns(); track g.key) {
            <section class="group/col bg-muted/30 flex h-full w-[18rem] shrink-0 flex-col rounded-lg">
              <header class="flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3 text-[13px]">
                <ng-container *ngTemplateOutlet="label().template; context: { $implicit: g.key }" />
                <span class="text-muted-foreground text-xs font-normal tabular-nums">{{ g.items.length }}</span>
                @if (addable()) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto flex size-6 items-center justify-center rounded-md"
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
                class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
                (cdkDropListDropped)="drop($event)"
              >
                @for (item of g.items; track track()(item)) {
                  <div cdkDrag [cdkDragData]="item" [cdkDragDisabled]="disabled()" class="cursor-grab">
                    <ng-container *ngTemplateOutlet="items().template; context: { $implicit: item }" />
                  </div>
                } @empty {
                  <p class="text-muted-foreground/70 border-border rounded-md border border-dashed px-1 py-5 text-center text-xs">{{ emptyText() }}</p>
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

  private readonly items = contentChild.required(KanbanItemDirective<T>);
  private readonly label = contentChild.required(KanbanLabelDirective);
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
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

  protected drop(event: CdkDragDrop<readonly T[]>): void {
    if (this.disabled() || event.previousContainer === event.container) return;
    const item = event.item.data as T | undefined;
    if (!item) return;
    const to = event.container.id.slice(this.prefix().length + 1);
    this.moved.emit({ item, to });
  }
}
