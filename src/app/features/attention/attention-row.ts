import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideClock,
  LucideDynamicIcon,
  LucideArrowRight,
  LucideExternalLink,
  LucideEllipsis,
  LucideRotateCcw,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ATTENTION_KIND_META,
  TramaStore,
  shortDate,
  type AttentionItem,
} from '../../core';
import { EntityChip, Kbd, type EntityChipType } from '../../shared';
import { AgoPipe } from '../overview/ago';
import { ATTENTION_KIND_HELP, ATTENTION_KIND_VIEW, SEVERITY_VIEW } from './attention-kinds';
import { snoozePresets, type SnoozePreset } from './snooze';

/**
 * One My Attention row: icon, title, detail, entity context, since, and the inline actions that
 * resolve it (open the task or pull request, snooze, dismiss).
 */
@Component({
  selector: 'app-attention-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    Kbd,
    EntityChip,
    AgoPipe,
  ],
  host: {
    class: 'group/row relative block border-b outline-none',
    '[attr.data-row-id]': 'item().id',
    '[attr.data-focused]': 'focused() ? "" : null',
    '[class.bg-accent/60]': 'focused()',
    '(click)': 'rowClicked.emit()',
  },
  template: `
    <span
      class="absolute inset-y-0 start-0 w-0.5"
      [class]="severityBar()"
      aria-hidden="true"
    ></span>

    <div
      class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-6"
    >
      <span
        class="mt-0.5 inline-flex cursor-help"
        [hlmTooltip]="kindLabel() + ': ' + help()"
        position="right"
        tabindex="-1"
      >
        <svg
          [lucideIcon]="kind().icon"
          [size]="16"
          [strokeWidth]="1.75"
          [class]="kind().color"
        ></svg>
      </span>

      <div class="min-w-0">
        <div class="flex min-w-0 items-baseline gap-2">
          <a
            [routerLink]="primaryLink().commands"
            [queryParams]="primaryLink().query"
            class="hover:underline min-w-0 truncate text-sm font-medium focus-visible:underline focus-visible:outline-none"
            >{{ item().title }}</a
          >
          @if (item().severity === 'high' && mode() === 'open') {
            <span class="text-status-blocked shrink-0 text-[11px] font-medium">High</span>
          }
        </div>
        @if (item().detail) {
          <p class="text-meta mt-0.5 line-clamp-2 sm:truncate">{{ item().detail }}</p>
        }


      </div>

      <div class="col-span-full flex items-center gap-2 max-sm:ps-7 sm:col-span-1 sm:justify-end">
        @if (subjectChip(); as c) {
          <app-entity-chip [type]="c.type" [ref]="c.ref" compact class="max-sm:me-auto" />
        }
        <span
          class="text-meta w-9 text-end tabular-nums max-sm:w-auto"
          [class.max-sm:me-auto]="!subjectChip()"
          >{{ item().since | ago }}</span
        >

        @if (mode() === 'open') {
          <div
            class="flex items-center gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100 sm:group-data-[focused]/row:opacity-100"
          >
            <a
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              [routerLink]="primaryLink().commands"
              [queryParams]="primaryLink().query"
              tabindex="-1"
              hlmTooltip="Open (Enter)"
              position="bottom"
              aria-label="Open"
            >
              <svg [lucideIcon]="openIcon" [size]="14"></svg>
            </a>
            @if (artifactUrl(); as url) {
              <a
                hlmBtn
                variant="ghost"
                size="icon-sm"
                class="max-sm:size-9"
                [href]="url"
                target="_blank"
                rel="noopener noreferrer"
                hlmTooltip="Open pull request"
                position="bottom"
                aria-label="Open pull request"
              >
                <svg [lucideIcon]="external" [size]="14"></svg>
              </a>
            }
            <button
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
              <svg [lucideIcon]="clock" [size]="14"></svg>
            </button>
            <button
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              hlmTooltip="Dismiss (E)"
              position="bottom"
              aria-label="Dismiss"
              (click)="dismiss.emit()"
            >
              <svg [lucideIcon]="x" [size]="14"></svg>
            </button>
            <button
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              [hlmDropdownMenuTrigger]="moreMenu"
              align="end"
              aria-label="More actions"
            >
              <svg [lucideIcon]="more" [size]="14"></svg>
            </button>
          </div>
        } @else {
          <span class="text-meta hidden sm:inline">{{ archivedLabel() }}</span>
          <button hlmBtn variant="outline" size="sm" class="max-sm:h-9" (click)="restore.emit()">
            <svg [lucideIcon]="undo" [size]="13"></svg>
            Restore
          </button>
        }
      </div>
      @if (mode() === 'archived') {
        <span class="text-meta col-span-full ps-7 sm:hidden">{{ archivedLabel() }}</span>
      }
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

    <ng-template #moreMenu>
      <hlm-dropdown-menu class="w-52">
        @if (artifactUrl(); as url) {
          <button hlmDropdownMenuItem (triggered)="openExternal(url)">Open pull request</button>
          <hlm-dropdown-menu-separator />
        }
        <button hlmDropdownMenuItem (triggered)="dismiss.emit()">
          Dismiss
          <hlm-dropdown-menu-shortcut><app-kbd keys="e" /></hlm-dropdown-menu-shortcut>
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class AttentionRow {
  protected readonly store = inject(TramaStore);

  readonly item = input.required<AttentionItem>();
  readonly slug = input.required<string>();
  readonly mode = input<'open' | 'archived'>('open');
  readonly focused = input(false);

  readonly dismiss = output<void>();
  readonly snooze = output<string>();
  readonly pickDate = output<void>();
  readonly restore = output<void>();
  readonly rowClicked = output<void>();

  protected readonly clock = LucideClock;
  protected readonly x = LucideX;
  protected readonly external = LucideExternalLink;
  protected readonly more = LucideEllipsis;
  protected readonly undo = LucideRotateCcw;
  protected readonly openIcon = LucideArrowRight;

  protected readonly kind = computed(() => ATTENTION_KIND_VIEW[this.item().kind]);
  protected readonly kindLabel = computed(() => ATTENTION_KIND_META[this.item().kind].label);
  protected readonly help = computed(() => ATTENTION_KIND_HELP[this.item().kind]);
  /** The entity the item is about, as a compact chip. */
  protected readonly subjectChip = computed<{ type: EntityChipType; ref: string } | null>(() => {
    const it = this.item();
    if (it.issueId && this.store.issueById().has(it.issueId))
      return { type: 'issue', ref: it.issueId };
    return null;
  });
  protected readonly severityBar = computed(() =>
    this.mode() === 'open' ? SEVERITY_VIEW[this.item().severity].bar : 'bg-transparent',
  );
  protected readonly artifactUrl = computed(() => {
    const id = this.item().artifactId;
    return id ? this.store.artifactById().get(id)?.url : undefined;
  });
  protected readonly presets = computed<SnoozePreset[]>(() => snoozePresets());

  protected readonly primaryLink = computed<{
    commands: unknown[];
    query?: Record<string, string>;
  }>(() => {
    const it = this.item();
    const slug = this.slug();
    if (it.kind === 'triage') {
      return { commands: ['/', slug, 'tasks'], query: { status: 'backlog' } };
    }
    const issue = it.issueId ? this.store.issueById().get(it.issueId) : undefined;
    return { commands: issue ? ['/', slug, 'tasks', issue.key] : ['/', slug, 'attention'] };
  });

  protected readonly archivedLabel = computed(() => {
    const it = this.item();
    if (it.state === 'snoozed')
      return it.snoozedUntil ? `Snoozed until ${shortDate(it.snoozedUntil)}` : 'Snoozed';
    return 'Dismissed';
  });

  private readonly router = inject(Router);

  protected go(commands: unknown[]): void {
    void this.router.navigate(commands);
  }

  protected openExternal(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
