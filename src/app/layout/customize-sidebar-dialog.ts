import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  CdkDrag,
  CdkDragHandle,
  CdkDropList,
  moveItemInArray,
  type CdkDragDrop,
} from '@angular/cdk/drag-drop';
import { LucideDynamicIcon, LucideGripVertical } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import {
  UiStore,
  type SidebarBadgeStyle,
  type SidebarSection,
  type SidebarVisibility,
} from '../core/stores/ui.store';
import { AppSelect, type Option } from '../shared/app-select';
import { MORE_NAV, PRIMARY_NAV, orderNav, type NavItem } from './nav';

const BADGE_OPTIONS: Option[] = [
  { value: 'count', label: 'Count' },
  { value: 'dot', label: 'Dot' },
];
const VISIBILITY_PLAIN: Option[] = [
  { value: 'always', label: 'Always show' },
  { value: 'hidden', label: 'Hide' },
];
const VISIBILITY_BADGED: Option[] = [
  { value: 'always', label: 'Always show' },
  { value: 'badged', label: 'Only when badged' },
  { value: 'hidden', label: 'Hide' },
];

/** "Customize sidebar": badge style, and per entry whether it is shown, plus drag-to-reorder. */
@Component({
  selector: 'app-customize-sidebar-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppSelect,
    HlmDialogImports,
    HlmButtonImports,
    LucideDynamicIcon,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="ui.closeModal()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
      >
        <hlm-dialog-header class="px-5 pt-4 pb-3">
          <h2 hlmDialogTitle class="text-sm font-semibold">Customize sidebar</h2>
          <p hlmDialogDescription class="sr-only">
            Choose which entries the sidebar shows, in what order, and how badges look.
          </p>
        </hlm-dialog-header>

        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-4">
          <div
            class="bg-muted/50 flex items-center justify-between rounded-lg px-3 py-2 text-[13px]"
          >
            <label for="sidebar-badge-style" class="font-medium">Default badge style</label>
            <app-select
              class="w-28"
              size="sm"
              controlId="sidebar-badge-style"
              [options]="badgeOptions"
              [value]="ui.sidebarBadgeStyle()"
              (valueChange)="setBadgeStyle($any($event))"
            />
          </div>

          @for (group of groups(); track group.section) {
            <section>
              <h3 class="text-muted-foreground mb-1.5 text-xs font-medium">{{ group.title }}</h3>
              <ul
                class="bg-muted/50 rounded-lg p-1"
                cdkDropList
                [attr.aria-label]="group.title + ' entries'"
                (cdkDropListDropped)="drop(group.section, $event)"
              >
                @for (item of group.items; track item.segment) {
                  <li
                    cdkDrag
                    cdkDragLockAxis="y"
                    class="bg-background/0 flex h-9 items-center gap-2 rounded-md px-1.5 text-[13px]"
                  >
                    <span
                      cdkDragHandle
                      class="text-muted-foreground/60 hover:text-foreground flex size-5 cursor-grab items-center justify-center"
                      aria-hidden="true"
                    >
                      <svg [lucideIcon]="grip" [size]="14"></svg>
                    </span>
                    <svg
                      [lucideIcon]="item.icon"
                      [size]="14"
                      class="text-muted-foreground shrink-0"
                    ></svg>
                    <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                    <app-select
                      class="w-40"
                      size="sm"
                      [label]="'Visibility of ' + item.label"
                      [options]="item.badge ? visibilityBadged : visibilityPlain"
                      [value]="ui.sidebarVisibilityOf(item.segment)"
                      (valueChange)="setVisibility(item.segment, $any($event))"
                    />
                  </li>
                }
              </ul>
            </section>
          }
        </div>

        <div class="flex h-12 shrink-0 items-center justify-between px-5">
          <button
            hlmBtn
            variant="ghost"
            size="sm"
            class="text-muted-foreground"
            (click)="ui.resetSidebarLayout()"
          >
            Reset to default
          </button>
          <button hlmBtn size="sm" (click)="ui.closeModal()">Done</button>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class CustomizeSidebarDialog {
  protected readonly ui = inject(UiStore);
  protected readonly grip = LucideGripVertical;
  protected readonly badgeOptions = BADGE_OPTIONS;
  protected readonly visibilityPlain = VISIBILITY_PLAIN;
  protected readonly visibilityBadged = VISIBILITY_BADGED;
  protected readonly open = computed(() => this.ui.modal() === 'customize-sidebar');

  protected readonly groups = computed<
    { section: SidebarSection; title: string; items: NavItem[] }[]
  >(() => {
    const order = this.ui.sidebarOrder();
    return [
      // The stored section ids predate the Inbox: `personal` is the main list, `workspace` is "More".
      { section: 'personal', title: 'Main', items: orderNav(PRIMARY_NAV, order.personal) },
      { section: 'workspace', title: 'More', items: orderNav(MORE_NAV, order.workspace) },
    ];
  });

  protected setBadgeStyle(value: SidebarBadgeStyle): void {
    this.ui.sidebarBadgeStyle.set(value);
  }

  protected setVisibility(segment: string, value: SidebarVisibility): void {
    this.ui.setSidebarVisibility(segment, value);
  }

  protected drop(section: SidebarSection, e: CdkDragDrop<unknown>): void {
    if (e.previousIndex === e.currentIndex) return;
    const group = this.groups().find((g) => g.section === section);
    if (!group) return;
    const segments = group.items.map((i) => i.segment);
    moveItemInArray(segments, e.previousIndex, e.currentIndex);
    this.ui.setSidebarOrder(section, segments);
  }
}
