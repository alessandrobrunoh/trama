// Searchable single / multi picker built on Spartan popover + command. Used for filter chips,
// the properties sidebar and the form fields of the create dialogs.
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
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
import type { ActorRef } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { PriorityIcon } from '../../shared/priority-icon';
import { ProviderIcon, type AnyProvider } from '../../shared/provider-icon';
import { StatusIcon, type AnyStatus } from '../../shared/status';
import type { Priority } from '../../core';

export type PickKind =
  | 'plain'
  | 'status'
  | 'priority'
  | 'team'
  | 'user'
  | 'agent'
  | 'actor'
  | 'provider'
  | 'repo'
  | 'label';

export interface PickOption {
  value: string;
  label: string;
  kind?: PickKind;
  /** Right-aligned secondary text (e.g. the team key). */
  hint?: string;
  /** Overrides the search text (defaults to the label). */
  search?: string;
  /** Status glyph when it differs from `value` (kind `status`). */
  status?: string;
  /** Git provider for `repo` options. */
  provider?: string;
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
 *  - `field` : borderless row button for property panels
 *  - `input` : bordered full-width control for forms
 *  - `ghost` : compact ghost button (summary text only)
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
    NgTemplateOutlet,
  ],
  host: { class: 'inline-block min-w-0 max-w-full' },
  template: `
    <hlm-popover align="start" sideOffset="4" [state]="state()" (stateChanged)="state.set($event)">
      @switch (variant()) {
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
        @case ('field') {
          <button
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="ghost"
            class="h-auto min-h-8 w-full min-w-0 justify-start gap-1.5 px-1.5 py-1 text-left font-normal"
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
            <svg [lucideIcon]="chevron" [size]="14" class="text-muted-foreground ml-auto shrink-0"></svg>
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

      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-60 p-0 sm:w-64">
        <hlm-command class="h-auto max-h-[22rem] rounded-lg">
          @if (searchable()) {
            <hlm-command-input [placeholder]="searchPlaceholder() ?? 'Search ' + label().toLowerCase() + '…'" />
          }
          <div *hlmCommandEmptyState hlmCommandEmpty>No matches.</div>
          <hlm-command-list class="max-h-64">
            <hlm-command-group>
              @if (clearable() && selected().length > 0) {
                <button hlmCommandItem value="__clear" (selected)="clear()">
                  <span class="text-muted-foreground">{{ clearLabel() }}</span>
                </button>
              }
              @for (o of options(); track o.value) {
                <button hlmCommandItem [value]="(o.search ?? o.label) + ' ' + o.value" (selected)="pick(o)">
                  <ng-container *ngTemplateOutlet="glyph; context: { $implicit: o }" />
                  <span class="min-w-0 flex-1 truncate">{{ o.label }}</span>
                  @if (o.hint) {
                    <span class="text-muted-foreground font-mono text-[11px]">{{ o.hint }}</span>
                  }
                  @if (isSelected(o.value)) {
                    <svg [lucideIcon]="check" [size]="14" class="text-primary shrink-0"></svg>
                  }
                </button>
              }
            </hlm-command-group>
          </hlm-command-list>
          @if (create()) {
            <div class="border-t p-1">
              <button hlmBtn variant="ghost" size="sm" class="w-full justify-start" (click)="createClicked.emit()">
                <svg [lucideIcon]="plus" [size]="14"></svg>
                {{ create() }}
              </button>
            </div>
          }
        </hlm-command>
      </hlm-popover-content>
    </hlm-popover>

    <ng-template #glyph let-o>
      @switch (o.kind ?? 'plain') {
        @case ('status') {
          <app-status-icon [status]="asStatus(o.status ?? o.value)" />
        }
        @case ('priority') {
          <app-priority-icon [priority]="asPriority(o.value)" />
        }
        @case ('team') {
          <app-actor-avatar [actor]="teamRef(o.value)" [size]="16" />
        }
        @case ('user') {
          <app-actor-avatar [actor]="userRef(o.value)" [size]="16" />
        }
        @case ('agent') {
          <app-actor-avatar [actor]="agentRef(o.value)" [size]="16" />
        }
        @case ('actor') {
          <app-actor-avatar [actor]="actorRef(o.value)" [size]="16" />
        }
        @case ('provider') {
          <app-provider-icon [provider]="asProvider(o.value)" [size]="14" class="text-muted-foreground" />
        }
        @case ('repo') {
          <app-provider-icon [provider]="repoProvider(o)" [size]="13" class="text-muted-foreground" />
        }
        @case ('label') {
          <span class="bg-muted-foreground/50 size-2 shrink-0 rounded-full"></span>
        }
      }
    </ng-template>
  `,
})
export class Picker {
  readonly options = input.required<readonly PickOption[]>();
  /** Selected values. */
  readonly value = input<readonly string[]>([]);
  readonly multiple = input(false);
  readonly variant = input<'chip' | 'field' | 'input' | 'ghost'>('input');
  readonly label = input('Select');
  readonly placeholder = input('None');
  readonly searchPlaceholder = input<string>();
  readonly searchable = input(true);
  readonly clearable = input(false);
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

  private readonly byValue = computed(() => new Map(this.options().map((o) => [o.value, o])));
  protected readonly selected = computed<PickOption[]>(() =>
    this.value().map((v) => this.byValue().get(v) ?? { value: v, label: v }),
  );
  protected readonly summary = computed(() => {
    const s = this.selected();
    return s.length <= 2 ? s.map((x) => x.label).join(', ') : `${s.length} selected`;
  });
  private readonly selectedSet = computed(() => new Set(this.value()));

  protected isSelected(v: string): boolean {
    return this.selectedSet().has(v);
  }

  protected pick(o: PickOption): void {
    if (this.multiple()) {
      const set = new Set(this.value());
      if (set.has(o.value)) set.delete(o.value);
      else set.add(o.value);
      // keep option order
      this.valueChange.emit(this.options().filter((x) => set.has(x.value)).map((x) => x.value));
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
  protected asProvider = (v: string) => v as AnyProvider;
  protected teamRef = (v: string): ActorRef => ({ type: 'team', id: v });
  protected userRef = (v: string): ActorRef => ({ type: 'user', id: v });
  protected agentRef = (v: string): ActorRef => ({ type: 'agent', id: v });
  protected actorRef = (v: string): ActorRef => parseActor(v);
  protected repoProvider = (o: PickOption): AnyProvider => (o.provider === 'gitlab' ? 'gitlab' : 'github');
}
