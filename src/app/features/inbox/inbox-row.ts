// One row of the Inbox. Line one says why it is here, line two says what it is about. On the right: how long ago,
// the one action that resolves it, and quieter secondary actions on hover or focus.
//
// A single click previews the task in the right pane; Enter or a double click opens it.
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideCheck,
  LucideClock,
  LucideDynamicIcon,
  LucideExternalLink,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { Viewport } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { AgoPipe } from '../../shared/ago';
import { Kbd } from '../../shared/kbd';
import { StatusIcon } from '../../shared/status';
import { PreviewLink, isPreviewClick } from '../issues/list-preview';
import { laterLabel, type InboxEntry } from './inbox-model';
import { snoozePresets, type SnoozePreset } from '../attention/snooze';

@Component({
  selector: 'app-inbox-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    PreviewLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    Kbd,
    StatusIcon,
    AgoPipe,
  ],
  host: {
    class: 'group/row relative block outline-none',
    '[attr.data-row-id]': 'entry().id',
    '[attr.data-focused]': 'focused() ? "" : null',
    '[class.bg-selected]': 'selected()',
    '[class.hover:bg-hover]': '!selected()',
    '(click)': 'onRowClick($event)',
    '(dblclick)': 'onRowDblClick($event)',
  },
  template: `
    @let e = entry();
    @if (e.unread) {
      <span
        class="bg-primary absolute start-1.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full sm:start-2"
        role="img"
        aria-label="Unread"
      ></span>
    }
    <div
      class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 px-4 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-5"
    >
      <span class="flex size-5 items-center justify-center self-start pt-0.5 sm:self-center sm:pt-0" aria-hidden="true">
        @if (e.status) {
          <app-status-icon entity="issue" [status]="e.status" />
        } @else {
          <svg [lucideIcon]="e.icon" [size]="16" [strokeWidth]="1.75" [class]="e.iconColor"></svg>
        }
      </span>

      <a
        [appPreviewLink]="commands()"
        [queryParams]="e.query"
        [previewable]="!!e.issueKey"
        class="flex min-w-0 flex-col gap-0.5 outline-none focus-visible:underline"
        (preview)="preview.emit()"
      >
        <span class="truncate text-[13px] leading-snug" [class.text-muted-foreground]="e.section === 'later'">{{
          e.sentence
        }}</span>
        <span class="text-meta flex min-w-0 items-baseline gap-2">
          @if (e.key) {
            <span class="shrink-0 font-mono">{{ e.key }}</span>
          }
          @if (e.text) {
            <span class="truncate">{{ e.text }}</span>
          }
          @if (e.section === 'later') {
            <span class="shrink-0">· {{ laterText() }}</span>
          }
        </span>
      </a>

      <div class="col-span-full flex items-center gap-1.5 max-sm:ps-[1.875rem] sm:col-span-1 sm:justify-end">
        <time class="text-meta me-1 w-8 text-end tabular-nums max-sm:me-auto max-sm:text-start" [attr.datetime]="e.at">{{
          e.at | ago
        }}</time>

        <div
          class="flex items-center justify-end sm:w-14 sm:opacity-0 sm:transition-opacity sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100 sm:group-data-[focused]/row:opacity-100"
        >
          @if (e.canMarkDone) {
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              hlmTooltip="Mark done (D)"
              position="bottom"
              aria-label="Mark done"
              (click)="markDone.emit()"
            >
              <svg [lucideIcon]="checkIcon" [size]="14"></svg>
            </button>
          }
          @if (e.canMarkRead) {
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              hlmTooltip="Mark as read (E)"
              position="bottom"
              aria-label="Mark as read"
              (click)="markRead.emit()"
            >
              <svg [lucideIcon]="checkIcon" [size]="14"></svg>
            </button>
          }
          @if (e.canSnooze) {
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              [hlmDropdownMenuTrigger]="snoozeMenu"
              align="end"
              hlmTooltip="Snooze (H)"
              position="bottom"
              aria-label="Snooze"
            >
              <svg [lucideIcon]="clockIcon" [size]="14"></svg>
            </button>
          }
          @if (e.canDismiss) {
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              hlmTooltip="Dismiss (E)"
              position="bottom"
              aria-label="Dismiss"
              (click)="dismiss.emit()"
            >
              <svg [lucideIcon]="xIcon" [size]="14"></svg>
            </button>
          }
        </div>

        @switch (e.primary.type) {
          @case ('external') {
            <a
              hlmBtn
              variant="outline"
              size="sm"
              class="h-7 gap-1.5 px-2.5 text-xs sm:w-[5.5rem] max-sm:h-9"
              [href]="externalUrl()"
              target="_blank"
              rel="noopener noreferrer"
              [attr.aria-label]="e.primary.label + ': ' + e.sentence"
            >
              {{ e.primary.label }}
              <svg [lucideIcon]="externalIcon" [size]="12"></svg>
            </a>
          }
          @case ('open') {
            <a
              hlmBtn
              variant="outline"
              size="sm"
              class="h-7 px-2.5 text-xs sm:w-[5.5rem] max-sm:h-9"
              [routerLink]="commands()"
              [queryParams]="e.query"
              [attr.aria-label]="e.primary.label + ': ' + e.sentence"
              (click)="primary.emit()"
            >
              {{ e.primary.label }}
            </a>
          }
          @default {
            <button
              type="button"
              hlmBtn
              variant="outline"
              size="sm"
              class="h-7 px-2.5 text-xs sm:w-[5.5rem] max-sm:h-9"
              [attr.aria-label]="e.primary.label + ': ' + e.sentence"
              (click)="primary.emit()"
            >
              {{ e.primary.label }}
            </button>
          }
        }
      </div>
    </div>

    <ng-template #snoozeMenu>
      <hlm-dropdown-menu class="w-52">
        <hlm-dropdown-menu-label>Snooze until</hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          @for (p of presets(); track p.id) {
            <button hlmDropdownMenuItem (triggered)="snooze.emit(p.until)">
              {{ p.label }}
              <hlm-dropdown-menu-shortcut>{{ p.hint }}</hlm-dropdown-menu-shortcut>
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <button hlmDropdownMenuItem (triggered)="pickDate.emit()">
          Pick a date…
          <hlm-dropdown-menu-shortcut><app-kbd keys="h" /></hlm-dropdown-menu-shortcut>
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class InboxRow {
  readonly entry = input.required<InboxEntry>();
  readonly slug = input.required<string>();
  readonly focused = input(false);

  /** A single click on the row or its title: show the task in the right pane. */
  readonly preview = output<void>();
  /** Double click: open the row in full. */
  readonly open = output<void>();
  /** The row was clicked: it becomes the keyboard-focused row. */
  readonly rowClicked = output<void>();
  /** The primary button was pressed (links also navigate on their own). */
  readonly primary = output<void>();
  readonly snooze = output<string>();
  readonly pickDate = output<void>();
  readonly dismiss = output<void>();
  readonly markDone = output<void>();
  readonly markRead = output<void>();

  private readonly pane = inject(RightPaneStore);
  private readonly viewport = inject(Viewport);

  protected readonly checkIcon = LucideCheck;
  protected readonly clockIcon = LucideClock;
  protected readonly xIcon = LucideX;
  protected readonly externalIcon = LucideExternalLink;

  protected readonly commands = computed(() => ['/', this.slug(), ...this.entry().route]);
  protected readonly presets = computed<SnoozePreset[]>(() => (this.entry().canSnooze ? snoozePresets() : []));
  protected readonly externalUrl = computed(() => {
    const p = this.entry().primary;
    return p.type === 'external' ? p.url : null;
  });
  protected readonly laterText = computed(() => {
    const a = this.entry().attention;
    return a ? laterLabel(a) : '';
  });
  protected readonly selected = computed(() => {
    const key = this.entry().issueKey;
    const c = this.pane.content();
    return this.focused() || (!!key && c?.kind === 'task' && c.idOrKey === key);
  });

  /** A click anywhere on the row (not on a control) previews its task. */
  protected onRowClick(e: MouseEvent): void {
    this.rowClicked.emit();
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target?.closest('a, button') || this.viewport.isMobile() || !isPreviewClick(e)) return;
    if (this.entry().issueKey) this.preview.emit();
  }

  /** A double click anywhere on the row (not on a control) opens it in full. */
  protected onRowDblClick(e: MouseEvent): void {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target?.closest('a, button')) this.open.emit();
  }
}
