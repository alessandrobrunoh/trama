// Searchable single / multi picker built on Spartan popover + command. Used for filter chips,
// the properties sidebar and the form fields of the create dialogs.
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import {
  LucideCheck,
  LucideChevronDown,
  LucideDynamicIcon,
  LucidePlus,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { TramaStore, type ActorRef, type IssueKind, type Priority } from '../core';
import { ActorAvatar } from './actor-avatar';
import { EstimateGlyph } from './estimate';
import { IssueKindLabel } from './issue';
import { PriorityIcon } from './priority-icon';
import { ProviderIcon, type AnyProvider } from './provider-icon';
import { StatusIcon, type AnyStatus, type StatusEntity } from './status';
import { ProjectGlyph } from '../features/projects/project-glyph';

export type PickKind =
  | 'plain'
  | 'status'
  | 'priority'
  | 'user'
  | 'agent'
  | 'actor'
  | 'provider'
  | 'project'
  | 'label'
  | 'kind'
  | 'estimate';

export interface PickOption {
  value: string;
  label: string;
  kind?: PickKind;
  /** Right-aligned secondary text (e.g. a task key). */
  hint?: string;
  /** Overrides the search text (defaults to the label). */
  search?: string;
  /** Status glyph when it differs from `value` (kind `status`). */
  status?: string;
  /** Glyph family for status options. */
  statusEntity?: StatusEntity;
  /** Single key that picks this option while the list is open and not searchable ("3", "m"). */
  quickKey?: string;
  /** 0..1 position on the estimate scale (kind `estimate`); omitted/0 = empty glyph. */
  fraction?: number;
  /** Dot color for `label` options (`#rrggbb`). */
  color?: string;
  /** Consecutive options with the same group share a section header. */
  group?: string;
}

/** "user:usr_1" → ActorRef. */
export function parseActor(v: string): ActorRef {
  const i = v.indexOf(':');
  return { type: v.slice(0, i) as ActorRef['type'], id: v.slice(i + 1) };
}
export const actorValue = (a: ActorRef): string => `${a.type}:${a.id ?? ''}`;

/**
 * Popover + command list. Trigger styles:
 *  - `chip`  : dashed filter chip ("+ Status" / "Status · Working")
 *  - `pill`  : rounded property pill ("Priority" → "High"), used by the create composer
 *  - `field` : borderless row button for property panels
 *  - `input` : bordered full-width control for forms
 *  - `ghost` : compact ghost button (summary text only)
 *  - `bare`  : the projected content IS the trigger (inline row editors: a status glyph, an avatar…)
 *
 * `open()` / `close()` open the list programmatically (keyboard shortcuts).
 */
@Component({
  selector: 'app-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmPopoverImports,
    HlmCommandImports,
    HlmButtonImports,
    LucideDynamicIcon,
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    ProviderIcon,
    IssueKindLabel,
    EstimateGlyph,
    ProjectGlyph,
    NgTemplateOutlet,
  ],
  host: {
    class: 'inline-block min-w-0 max-w-full',
    '[class.shrink-0]': "variant() === 'chip' || variant() === 'pill'",
  },
  template: `
    <hlm-popover
      [align]="align()"
      sideOffset="4"
      [state]="state()"
      (stateChanged)="state.set($event)"
    >
      @switch (variant()) {
        @case ('bare') {
          <button
            hlmPopoverTrigger
            type="button"
            class="focus-visible:ring-ring hover:bg-accent inline-flex min-w-0 max-w-full items-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none"
            [class]="triggerClass()"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            <ng-content />
          </button>
        }
        @case ('chip') {
          <button
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="outline"
            size="sm"
            class="h-7 max-w-full gap-1.5 border-dashed px-2 text-xs font-normal"
            [class.border-solid]="selected().length > 0"
            [class.bg-accent]="selected().length > 0"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            @if (icon(); as ic) {
              <svg [lucideIcon]="ic" [size]="13" class="text-muted-foreground shrink-0"></svg>
            }
            <span class="text-muted-foreground">{{ label() }}</span>
            @if (selected().length) {
              <span class="bg-border h-3.5 w-px shrink-0"></span>
              <span class="flex min-w-0 items-center gap-1 truncate">
                @if (selected().length === 1) {
                  <ng-container *ngTemplateOutlet="glyph; context: { $implicit: selected()[0] }" />
                  <span class="truncate">{{ selected()[0].label }}</span>
                } @else {
                  <span>{{ selected().length }} selected</span>
                }
              </span>
            }
          </button>
        }
        @case ('pill') {
          <button
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="ghost"
            size="sm"
            class="border-border hover:bg-hover h-[22px] max-w-full gap-1.5 border px-2 font-mono text-[11px] font-normal"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            @if (selected().length === 1) {
              <ng-container *ngTemplateOutlet="glyph; context: { $implicit: selected()[0] }" />
              <span class="text-foreground truncate">{{ selected()[0].label }}</span>
            } @else if (selected().length > 1) {
              <span class="text-muted-foreground">{{ label() }}</span>
              <span class="bg-border h-3.5 w-px shrink-0"></span>
              <span class="text-foreground">{{ selected().length }}</span>
            } @else {
              @if (icon(); as ic) {
                <svg [lucideIcon]="ic" [size]="13" class="text-muted-foreground shrink-0"></svg>
              }
              <span class="text-muted-foreground">{{ label() }}</span>
            }
          </button>
        }
        @case ('field') {
          <button
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="ghost"
            class="h-auto min-h-8 w-full min-w-0 justify-start gap-1.5 px-1.5 py-1 text-left font-normal"
            [class]="triggerClass()"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            @if (selected().length === 0) {
              <span class="text-muted-foreground">{{ placeholder() }}</span>
            } @else {
              <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                @for (s of selected(); track s.value) {
                  <span class="flex min-w-0 items-center gap-1.5">
                    <ng-container *ngTemplateOutlet="glyph; context: { $implicit: s }" />
                    <span class="truncate">{{ s.label }}</span>
                  </span>
                }
              </span>
            }
          </button>
        }
        @case ('input') {
          <button
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="outline"
            class="w-full min-w-0 justify-between gap-1.5 px-2.5 font-normal"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            @if (selected().length === 0) {
              <span class="text-muted-foreground truncate">{{ placeholder() }}</span>
            } @else {
              <span class="flex min-w-0 items-center gap-1.5 truncate">
                @if (selected().length <= 2) {
                  @for (s of selected(); track s.value) {
                    <span class="flex min-w-0 items-center gap-1.5">
                      <ng-container *ngTemplateOutlet="glyph; context: { $implicit: s }" />
                      <span class="truncate">{{ s.label }}</span>
                    </span>
                  }
                } @else {
                  <span>{{ selected().length }} selected</span>
                }
              </span>
            }
            <svg
              [lucideIcon]="chevron"
              [size]="14"
              class="text-muted-foreground ml-auto shrink-0"
            ></svg>
          </button>
        }
        @default {
          <button
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="ghost"
            size="sm"
            class="max-w-full gap-1.5 px-2 font-normal"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            @if (selected().length === 0) {
              <span class="text-muted-foreground">{{ placeholder() }}</span>
            } @else {
              <span class="text-muted-foreground">{{ label() }}:</span>
              @for (s of selected(); track s.value) {
                <ng-container *ngTemplateOutlet="glyph; context: { $implicit: s }" />
              }
              <span class="truncate">{{ summary() }}</span>
            }
          </button>
        }
      }

      <!-- v3 · 17: 300px list on the raised step, search row 37px, rows 34px, "Unassign"-style clear row last -->
      <hlm-popover-content
        *hlmPopoverPortal="let ctx"
        class="w-60 p-0 sm:w-64"
        [style.width]="people() ? '300px' : null"
      >
        <hlm-command class="h-auto max-h-[22rem]" (keydown)="onQuickKey($event)">
          @if (searchable()) {
            <hlm-command-input
              [placeholder]="searchPlaceholder() ?? 'Search ' + label().toLowerCase() + '…'"
            />
          }
          <div *hlmCommandEmptyState hlmCommandEmpty>No matches.</div>
          <hlm-command-list class="max-h-64">
            @if (clearable() && clearAlways()) {
              <hlm-command-group class="p-1">
                <button hlmCommandItem value="__clear" (selected)="clear()">
                  <span class="text-muted-foreground min-w-0 flex-1 truncate">{{
                    clearLabel()
                  }}</span>
                  @if (selected().length === 0) {
                    <svg [lucideIcon]="check" [size]="14" class="text-foreground shrink-0"></svg>
                  }
                </button>
              </hlm-command-group>
            }
            @for (g of optionGroups(); track $index) {
              <hlm-command-group class="p-1">
                @if (g.label) {
                  <hlm-command-group-label class="px-2! pt-1.5! pb-1!">{{
                    g.label
                  }}</hlm-command-group-label>
                }
                @for (o of g.items; track o.value) {
                  <button
                    hlmCommandItem
                    class="px-2"
                    [class.text-muted-foreground]="isPerson(o)"
                    [value]="(o.search ?? o.label) + ' ' + o.value"
                    (selected)="pick(o)"
                  >
                    <ng-container
                      *ngTemplateOutlet="glyph; context: { $implicit: o, size: isPerson(o) ? 22 : 16 }"
                    />
                    <span class="min-w-0 flex-1 truncate">{{ o.label }}</span>
                    @if (o.hint) {
                      <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ o.hint }}</span>
                    }
                    @if (isSelected(o.value)) {
                      <svg [lucideIcon]="check" [size]="14" class="text-foreground shrink-0"></svg>
                    }
                  </button>
                }
              </hlm-command-group>
            }
            @if (clearable() && !clearAlways() && selected().length > 0) {
              <div class="bg-border h-px w-full" role="separator"></div>
              <hlm-command-group class="p-1">
                <button hlmCommandItem value="__clear" class="px-3" (selected)="clear()">
                  <span class="text-muted-foreground min-w-0 flex-1 truncate">{{
                    clearLabel()
                  }}</span>
                </button>
              </hlm-command-group>
            }
          </hlm-command-list>
          @if (create()) {
            <div class="p-1">
              <button
                hlmBtn
                variant="ghost"
                size="sm"
                class="w-full justify-start"
                (click)="createClicked.emit()"
              >
                <svg [lucideIcon]="plus" [size]="14"></svg>
                {{ create() }}
              </button>
            </div>
          }
        </hlm-command>
      </hlm-popover-content>
    </hlm-popover>

    <ng-template #glyph let-o let-size="size">
      @switch (o.kind ?? 'plain') {
        @case ('status') {
          <app-status-icon
            [status]="asStatus(o.status ?? o.value)"
            [entity]="o.statusEntity ?? 'auto'"
          />
        }
        @case ('priority') {
          <app-priority-icon [priority]="asPriority(o.value)" />
        }
        @case ('user') {
          <app-actor-avatar [actor]="userRef(o.value)" [size]="size ?? 16" />
        }
        @case ('agent') {
          <app-actor-avatar [actor]="agentRef(o.value)" [size]="size ?? 16" />
        }
        @case ('actor') {
          <app-actor-avatar [actor]="actorRef(o.value)" [size]="size ?? 16" />
        }
        @case ('provider') {
          <app-provider-icon
            [provider]="asProvider(o.value)"
            [size]="14"
            class="text-muted-foreground"
          />
        }
        @case ('project') {
          @if (projectOf(o.value); as pj) {
            <app-project-glyph [project]="pj" [size]="14" />
          } @else {
            <span class="bg-muted-foreground/50 size-2 shrink-0 rounded-full"></span>
          }
        }
        @case ('label') {
          <span class="size-2 shrink-0 rounded-full" [style.background]="o.color || 'var(--color-muted-foreground)'"></span>
        }
        @case ('kind') {
          <app-issue-kind [kind]="asKind(o.value)" [size]="14" />
        }
        @case ('estimate') {
          <app-estimate-glyph
            class="text-muted-foreground"
            [fraction]="o.fraction ?? 0"
            [size]="14"
          />
        }
      }
    </ng-template>
  `,
})
export class Picker {
  private readonly store = inject(TramaStore);
  readonly options = input.required<readonly PickOption[]>();
  /** Selected values. */
  readonly value = input<readonly string[]>([]);
  readonly multiple = input(false);
  readonly variant = input<'chip' | 'pill' | 'field' | 'input' | 'ghost' | 'bare'>('input');
  /** Extra classes for the `bare` trigger button. */
  readonly triggerClass = input('');
  readonly align = input<'start' | 'center' | 'end'>('start');
  readonly label = input('Select');
  readonly placeholder = input('None');
  readonly searchPlaceholder = input<string>();
  readonly searchable = input(true);
  readonly clearable = input(false);
  /** Keep the clear row ("No estimate") at the top even when nothing is selected, checked when empty. */
  readonly clearAlways = input(false);
  readonly clearLabel = input('Clear');
  readonly disabled = input(false);
  readonly icon = input<LucideIcon | null>(null);
  /** Adds a "+ label" row under the list (emits `createClicked`). */
  readonly create = input<string>();

  readonly valueChange = output<string[]>();
  readonly createClicked = output<void>();

  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly chevron = LucideChevronDown;
  protected readonly check = LucideCheck;
  protected readonly plus = LucidePlus;

  protected readonly optionGroups = computed(() => {
    const groups: { key: string; label: string | undefined; items: PickOption[] }[] = [];
    for (const o of this.options()) {
      const key = o.group ?? '';
      const last = groups.at(-1);
      if (last && last.key === key) last.items.push(o);
      else groups.push({ key, label: o.group, items: [o] });
    }
    return groups;
  });
  /** Lists of people get the wider v3 · 17 layout (22px avatars, 300px). */
  protected readonly people = computed(() => this.options().some((o) => this.isPerson(o)));
  protected isPerson(o: PickOption): boolean {
    return o.kind === 'user' || o.kind === 'agent' || o.kind === 'actor';
  }
  private readonly byValue = computed(() => new Map(this.options().map((o) => [o.value, o])));
  protected readonly selected = computed<PickOption[]>(() =>
    this.value().map((v) => this.byValue().get(v) ?? { value: v, label: v }),
  );
  protected readonly summary = computed(() => {
    const s = this.selected();
    return s.length <= 2 ? s.map((x) => x.label).join(', ') : `${s.length} selected`;
  });
  private readonly selectedSet = computed(() => new Set(this.value()));

  /** Open the option list (e.g. from a keyboard shortcut). */
  open(): void {
    if (!this.disabled()) this.state.set('open');
  }

  close(): void {
    this.state.set('closed');
  }

  /** Option shortcuts (`quickKey`) in lists without a search box. */
  protected onQuickKey(e: KeyboardEvent): void {
    if (this.searchable() || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    const k = e.key.toLowerCase();
    const hit = this.options().find((o) => o.quickKey === k);
    if (!hit) return;
    e.preventDefault();
    this.pick(hit);
  }

  protected isSelected(v: string): boolean {
    return this.selectedSet().has(v);
  }

  protected pick(o: PickOption): void {
    if (this.multiple()) {
      const set = new Set(this.value());
      if (set.has(o.value)) set.delete(o.value);
      else set.add(o.value);
      // keep option order
      this.valueChange.emit(
        this.options()
          .filter((x) => set.has(x.value))
          .map((x) => x.value),
      );
    } else {
      this.valueChange.emit([o.value]);
      this.state.set('closed');
    }
  }

  protected clear(): void {
    this.valueChange.emit([]);
    this.state.set('closed');
  }

  protected asStatus = (v: string) => v as AnyStatus;
  protected asPriority = (v: string) => v as Priority;
  protected asKind = (v: string) => v as IssueKind;
  protected asProvider = (v: string) => v as AnyProvider;
  protected projectOf = (id: string) => this.store.getProject(id);
  protected userRef = (v: string): ActorRef => ({ type: 'user', id: v });
  protected agentRef = (v: string): ActorRef => ({ type: 'agent', id: v });
  protected actorRef = (v: string): ActorRef => parseActor(v);
}
