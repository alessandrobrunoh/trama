import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { LucideBox, LucideCheck, LucideDynamicIcon, type LucideIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore } from '../../core';
import type { Project } from '../../core/contracts/domain';

/**
 * The curated icon set (`project-icons.ts`) is loaded on first use through a dynamic import, so its
 * ~110 icons stay out of the initial bundle. Until it arrives (or when it is not needed) the default
 * glyph is drawn; emoji never need it.
 */
const iconModule = signal<typeof import('./project-icons') | null>(null);
let iconModulePromise: Promise<void> | undefined;
function loadIcons(): void {
  iconModulePromise ??= import('./project-icons').then((m) => iconModule.set(m));
}

/** The glyph used when a project has no (or an unknown) icon. */
export const DEFAULT_PROJECT_ICON: LucideIcon = LucideBox;

/** Same shape the API accepts for an emoji: one pictograph (with modifiers / ZWJ sequence) or a flag. */
const EMOJI_PATTERN = new RegExp(
  '^(?:\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?' +
    '(?:\\u200D\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)*|\\p{Regional_Indicator}{2})$',
  'u',
);

export const isEmojiIcon = (value: string | undefined | null): value is string =>
  !!value && value.length <= 48 && EMOJI_PATTERN.test(value);

/** Curated palette for project colours (stored data, so hex values; muted hues that read on light and dark). */
export const PROJECT_COLORS: readonly { value: string; label: string }[] = [
  { value: '#6b7280', label: 'Grey' },
  { value: '#64748b', label: 'Slate' },
  { value: '#ef4444', label: 'Red' },
  { value: '#f97316', label: 'Orange' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#84cc16', label: 'Lime' },
  { value: '#22c55e', label: 'Green' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#0ea5e9', label: 'Sky' },
  { value: '#2b7fff', label: 'Blue' },
  { value: '#6366f1', label: 'Indigo' },
  { value: '#8b5cf6', label: 'Violet' },
  { value: '#d946ef', label: 'Fuchsia' },
  { value: '#ec4899', label: 'Pink' },
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The project's glyph: a curated lucide icon or an emoji, tinted with the project colour. */
@Component({
  selector: 'app-project-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class: 'inline-flex shrink-0 items-center justify-center leading-none',
    'aria-hidden': 'true',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
  },
  template: `
    @if (emoji(); as e) {
      <span class="leading-none select-none" [style.font-size.px]="size() * 0.85">{{ e }}</span>
    } @else {
      <svg [lucideIcon]="lucide()" [size]="size()" [style.color]="project().color"></svg>
    }
  `,
})
export class ProjectGlyph {
  readonly project = input.required<Project>();
  readonly size = input(16);

  /** A stored name (not an emoji, not the default): needs the icon table. */
  private readonly named = computed(() => {
    const icon = this.project().icon;
    return !!icon && icon !== 'box' && !isEmojiIcon(icon);
  });

  protected readonly emoji = computed(() => {
    const icon = this.project().icon;
    return isEmojiIcon(icon) ? icon : null;
  });
  protected readonly lucide = computed<LucideIcon>(() => {
    const icon = this.project().icon;
    const table = this.named() ? iconModule() : null;
    return (icon ? table?.ICON_BY_NAME.get(icon) : undefined) ?? DEFAULT_PROJECT_ICON;
  });

  constructor() {
    effect(() => {
      if (this.named()) loadIcons();
    });
  }
}

/**
 * Glyph button that opens a popover to change the icon (curated lucide set or an emoji) and the colour.
 * Read-only glyph when `canEdit` is false. Saves through `store.updateProject`.
 */
@Component({
  selector: 'app-project-glyph-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ProjectGlyph,
    HlmPopoverImports,
    HlmTabsImports,
    HlmButtonImports,
    HlmInputImports,
    HlmTooltip,
    LucideDynamicIcon,
  ],
  host: { class: 'inline-flex shrink-0' },
  template: `
    @if (canEdit()) {
      <hlm-popover
        align="start"
        sideOffset="6"
        [state]="state()"
        (stateChanged)="state.set($event)"
      >
        <button
          hlmPopoverTrigger
          type="button"
          class="hover:bg-accent focus-visible:ring-ring flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2"
          hlmTooltip="Change icon and colour"
          aria-label="Change project icon and colour"
        >
          <app-project-glyph [project]="project()" [size]="size()" />
        </button>
        <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72 p-2">
          <hlm-tabs [tab]="tab()" (tabActivated)="tab.set($event === 'color' ? 'color' : 'icon')">
            <hlm-tabs-list variant="line" class="mb-2 h-8 w-full p-0">
              <button hlmTabsTrigger="icon" class="px-2">Icon</button>
              <button hlmTabsTrigger="color" class="px-2">Color</button>
            </hlm-tabs-list>
          </hlm-tabs>

          @if (tab() === 'icon') {
            <input
              hlmInput
              class="mb-2 h-8 w-full text-sm"
              type="search"
              placeholder="Search icons…"
              aria-label="Search icons"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
            />
            <div
              class="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto"
              role="group"
              aria-label="Project icon"
            >
              @for (i of filtered(); track i.name) {
                <button
                  type="button"
                  class="hover:bg-accent focus-visible:ring-ring flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2"
                  [class.bg-accent]="isCurrent(i.name)"
                  [attr.aria-label]="i.name"
                  [attr.aria-pressed]="isCurrent(i.name)"
                  [hlmTooltip]="i.name"
                  (click)="pickIcon(i.name)"
                >
                  <svg [lucideIcon]="i.icon" [size]="16" [style.color]="project().color"></svg>
                </button>
              } @empty {
                <p class="text-meta col-span-8 py-4 text-center">
                  {{ iconsReady() ? 'No icon matches “' + query() + '”.' : 'Loading icons…' }}
                </p>
              }
            </div>
            <form
              class="mt-2 flex items-center gap-1.5"
              (submit)="$event.preventDefault(); applyEmoji()"
            >
              <input
                hlmInput
                class="h-8 min-w-0 flex-1 text-sm"
                placeholder="Or paste an emoji"
                aria-label="Emoji"
                autocomplete="off"
                [value]="emojiDraft()"
                [attr.aria-invalid]="emojiDraft() && !emojiValid() ? 'true' : null"
                (input)="emojiDraft.set($any($event.target).value.trim())"
              />
              <button hlmBtn type="submit" size="sm" variant="outline" [disabled]="!emojiValid()">
                Use
              </button>
            </form>
            @if (project().icon) {
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="sm"
                class="text-muted-foreground mt-1 w-full justify-start"
                (click)="removeIcon()"
              >
                Remove icon
              </button>
            }
          } @else {
            <div class="grid grid-cols-5 gap-1.5" role="group" aria-label="Project colour">
              @for (c of colors; track c.value) {
                <button
                  type="button"
                  class="ring-offset-popover focus-visible:ring-ring flex size-8 items-center justify-center justify-self-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-offset-2"
                  [style.background]="c.value"
                  [attr.aria-label]="c.label"
                  [attr.aria-pressed]="sameColor(c.value)"
                  [hlmTooltip]="c.label"
                  (click)="pickColor(c.value)"
                >
                  @if (sameColor(c.value)) {
                    <svg
                      [lucideIcon]="check"
                      [size]="14"
                      [strokeWidth]="3"
                      class="text-background"
                    ></svg>
                  }
                </button>
              }
            </div>
            <form
              class="mt-3 flex items-center gap-1.5"
              (submit)="$event.preventDefault(); applyHex()"
            >
              <span
                class="size-5 shrink-0 rounded-full border"
                [style.background]="hexValid() ? hexDraft() : project().color"
              ></span>
              <input
                hlmInput
                class="h-8 min-w-0 flex-1 font-mono text-sm"
                placeholder="#2b7fff"
                aria-label="Hex colour"
                maxlength="7"
                autocomplete="off"
                spellcheck="false"
                [value]="hexDraft()"
                [attr.aria-invalid]="hexDraft() && !hexValid() ? 'true' : null"
                (input)="hexDraft.set($any($event.target).value.trim())"
              />
              <button hlmBtn type="submit" size="sm" variant="outline" [disabled]="!hexValid()">
                Set
              </button>
            </form>
            @if (hexDraft() && !hexValid()) {
              <p class="text-destructive mt-1 text-xs" role="alert">
                Use a 6-digit hex colour such as #2b7fff.
              </p>
            }
          }
        </hlm-popover-content>
      </hlm-popover>
    } @else {
      <span class="inline-flex size-8 items-center justify-center">
        <app-project-glyph [project]="project()" [size]="size()" />
      </span>
    }
  `,
})
export class ProjectGlyphPicker {
  private readonly store = inject(NablaStore);

  readonly project = input.required<Project>();
  readonly canEdit = input.required<boolean>();
  /** Glyph size in the trigger. */
  readonly size = input(18);

  protected readonly colors = PROJECT_COLORS;
  protected readonly check = LucideCheck;
  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly tab = signal<'icon' | 'color'>('icon');
  protected readonly query = signal('');
  protected readonly emojiDraft = signal('');
  protected readonly hexDraft = signal('');
  protected readonly iconsReady = computed(() => iconModule() !== null);

  constructor() {
    effect(() => {
      if (this.state() === 'open') loadIcons();
    });
  }

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase().replace(/\s+/g, '-');
    const all = iconModule()?.PROJECT_ICONS ?? [];
    return q ? all.filter((i) => i.name.includes(q)) : all;
  });
  protected readonly emojiValid = computed(() => isEmojiIcon(this.emojiDraft()));
  protected readonly hexValid = computed(() => HEX_COLOR.test(this.hexDraft()));

  protected isCurrent(name: string): boolean {
    return (this.project().icon ?? 'box') === name;
  }

  protected sameColor(value: string): boolean {
    return value.toLowerCase() === this.project().color.toLowerCase();
  }

  protected pickIcon(name: string): void {
    // the default glyph is stored as "no icon"
    const icon = name === 'box' ? null : name;
    if ((this.project().icon ?? null) !== icon)
      void this.store.updateProject(this.project().id, { icon });
    this.state.set('closed');
  }

  protected applyEmoji(): void {
    const emoji = this.emojiDraft();
    if (!isEmojiIcon(emoji)) return;
    if (this.project().icon !== emoji)
      void this.store.updateProject(this.project().id, { icon: emoji });
    this.emojiDraft.set('');
    this.state.set('closed');
  }

  protected removeIcon(): void {
    void this.store.updateProject(this.project().id, { icon: null });
    this.state.set('closed');
  }

  protected pickColor(value: string): void {
    if (!this.sameColor(value)) void this.store.updateProject(this.project().id, { color: value });
    this.state.set('closed');
  }

  protected applyHex(): void {
    const hex = this.hexDraft();
    if (!HEX_COLOR.test(hex)) return;
    this.pickColor(hex.toLowerCase());
    this.hexDraft.set('');
  }
}
