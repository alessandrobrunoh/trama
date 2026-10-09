// Label picker: search, tick several, and create a label from what you typed. Used on the detail
// pages of issues, workstreams, projects and repositories, and as the label filter on lists.
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideDynamicIcon, LucidePlus, LucideSettings2, LucideTag } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { LABEL_NAME_MAX, NablaStore, type WorkspaceLabel } from '../core';
import { LabelCatalog } from './label-catalog';
import { LabelChip, LabelChips } from './label-chip';

/**
 * Trigger styles: `field` (borderless row of chips for property panels) and `chip` (dashed filter chip).
 * Set `creatable` to false for filters: they never create labels.
 * Emits the new list of ids; the order of what is already picked is kept, new picks go last.
 */
@Component({
  selector: 'app-label-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmPopoverImports, HlmCommandImports, HlmButtonImports, LucideDynamicIcon, LabelChip, LabelChips, RouterLink],
  host: { class: 'inline-block min-w-0 max-w-full', '[class.shrink-0]': "variant() === 'chip'" },
  template: `
    <hlm-popover [align]="align()" sideOffset="4" [state]="state()" (stateChanged)="onState($event)">
      @switch (variant()) {
        @case ('chip') {
          <button
            #trigger
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="outline"
            size="sm"
            class="h-7 max-w-full gap-1.5 border-dashed px-2 text-xs font-normal"
            [class.border-solid]="value().length > 0"
            [class.bg-accent]="value().length > 0"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            <svg [lucideIcon]="tag" [size]="13" class="text-muted-foreground shrink-0"></svg>
            <span class="text-muted-foreground">{{ label() }}</span>
            @if (known().length) {
              <span class="bg-border h-3.5 w-px shrink-0"></span>
              @if (known().length === 1) {
                <app-label-chip [labelId]="known()[0]" />
              } @else {
                <span>{{ known().length }} selected</span>
              }
            }
          </button>
        }
        @default {
          <button
            #trigger
            hlmBtn
            hlmPopoverTrigger
            type="button"
            variant="ghost"
            class="h-auto min-h-8 w-full min-w-0 justify-start gap-1.5 px-1.5 py-1 text-left font-normal"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
          >
            @if (known().length === 0) {
              <span class="text-muted-foreground">{{ disabled() ? 'None' : placeholder() }}</span>
            } @else {
              <app-label-chips [ids]="known()" [max]="8" />
            }
          </button>
        }
      }

      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72 p-0">
        <hlm-command class="h-auto max-h-[26rem] rounded-lg" [search]="query()" (searchChange)="query.set($event)" (keydown.enter)="onEnter()">
          <hlm-command-input [placeholder]="creatable() && catalog.canCreate() ? 'Find or create a label…' : 'Find a label…'" />
          <hlm-command-list class="max-h-64">
            <hlm-command-group>
              @for (e of entries(); track e.key) {
                @if (e.heading) {
                  <div hlmCommandGroupLabel class="text-muted-foreground px-2 pt-1.5 pb-0.5 text-[11px] font-medium">{{ e.heading }}</div>
                } @else if (e.label; as l) {
                  <button hlmCommandItem [value]="l.name" [disabled]="!isOn(l.id) && atMax()" (selected)="toggle(l)">
                    <span
                      class="flex size-4 shrink-0 items-center justify-center rounded-[4px] border"
                      [class]="isOn(l.id) ? 'bg-primary border-primary text-primary-foreground' : 'border-border-strong'"
                      aria-hidden="true"
                    >
                      @if (isOn(l.id)) {
                        <svg [lucideIcon]="check" [size]="11" [strokeWidth]="3"></svg>
                      }
                    </span>
                    <span class="size-2 shrink-0 rounded-full" [style.background]="l.color"></span>
                    <span class="min-w-0 flex-1 truncate" [attr.aria-label]="isOn(l.id) ? l.name + ', selected' : l.name">{{ l.name }}</span>
                    @if (l.archived) {
                      <span class="text-muted-foreground text-[11px]">archived</span>
                    } @else if (usageOf(l.id); as n) {
                      <span class="text-muted-foreground text-[11px] tabular-nums">{{ n }}</span>
                    }
                  </button>
                }
              }
            </hlm-command-group>
            @if (createName(); as n) {
              <hlm-command-group>
                <button hlmCommandItem [value]="'create ' + n" [disabled]="busy()" (selected)="create(n)">
                  <svg [lucideIcon]="plus" [size]="14" class="text-muted-foreground shrink-0"></svg>
                  <span class="size-2 shrink-0 rounded-full" [style.background]="nextColor()"></span>
                  <span class="min-w-0 flex-1 truncate">Create “{{ n }}”</span>
                </button>
              </hlm-command-group>
            }
            @if (archivedClash(); as a) {
              <div class="text-muted-foreground px-2 py-2 text-xs">“{{ a.name }}” exists but is archived. An admin can restore it in Settings.</div>
            }
          </hlm-command-list>
          <div *hlmCommandEmptyState hlmCommandEmpty class="text-muted-foreground py-4 text-center text-xs">
            @if (catalog.active().length === 0) {
              No labels yet.
            } @else {
              No label matches “{{ query() }}”.
            }
          </div>
          @if (atMax()) {
            <div class="text-muted-foreground border-t px-3 py-1.5 text-[11px]">At most {{ catalog.maxPerRecord }} labels per item.</div>
          }
          @if (catalog.canManage() && manageLink()) {
            <div class="border-t p-1">
              <a
                hlmBtn
                variant="ghost"
                size="sm"
                class="text-muted-foreground w-full justify-start font-normal"
                [routerLink]="['/', slug(), 'settings', 'labels']"
                (click)="close()"
              >
                <svg [lucideIcon]="manage" [size]="14"></svg>
                Manage labels
              </a>
            </div>
          }
        </hlm-command>
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class LabelPicker {
  protected readonly catalog = inject(LabelCatalog);
  private readonly store = inject(NablaStore);

  /** Selected label ids. */
  readonly value = input<readonly string[]>([]);
  readonly variant = input<'field' | 'chip'>('field');
  readonly label = input('Labels');
  readonly placeholder = input('Add labels');
  readonly disabled = input(false);
  readonly align = input<'start' | 'center' | 'end'>('start');
  /** Offer "Create “name”" when the search matches nothing. Filters turn it off. */
  readonly creatable = input(true);
  /** Show the "Manage labels" link for admins. */
  readonly manageLink = input(true);

  readonly valueChange = output<string[]>();

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly query = signal('');
  protected readonly busy = signal(false);
  protected readonly tag = LucideTag;
  protected readonly check = LucideCheck;
  protected readonly plus = LucidePlus;
  protected readonly manage = LucideSettings2;
  protected readonly slug = computed(() => this.store.slug() ?? '');

  private readonly picked = computed(() => new Set(this.value()));
  /** Selected ids that still exist in the catalog. */
  protected readonly known = computed(() => this.value().filter((id) => this.catalog.byId().has(id)));
  protected readonly atMax = computed(() => this.value().length >= this.catalog.maxPerRecord);

  private readonly arranged = computed(() => this.catalog.arrange(this.picked(), !this.query().trim()));
  protected readonly suggested = computed(() => this.arranged().suggested);
  protected readonly listed = computed(() => this.arranged().rest);

  /** Rows of the list: optional headings, then labels. One flat group, so keyboard order is the visual order. */
  protected readonly entries = computed<{ key: string; heading?: string; label?: WorkspaceLabel }[]>(() => {
    const suggested = this.suggested();
    const out: { key: string; heading?: string; label?: WorkspaceLabel }[] = [];
    if (suggested.length) {
      out.push({ key: 'h-suggested', heading: 'Suggested' });
      for (const label of suggested) out.push({ key: `s-${label.id}`, label });
      out.push({ key: 'h-all', heading: 'All labels' });
    }
    for (const label of this.listed()) out.push({ key: label.id, label });
    return out;
  });

  /** The name that would be created: what was typed, when no label has it yet. */
  protected readonly createName = computed(() => {
    if (!this.creatable() || !this.catalog.canCreate()) return null;
    const name = this.query().trim();
    if (!name || name.length > LABEL_NAME_MAX || this.catalog.find(name)) return null;
    return name;
  });
  /** Does any listed label match what was typed? Enter then picks it; with no match, Enter creates. */
  private readonly hasMatch = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.entries().some((e) => e.label && e.label.name.toLowerCase().includes(q));
  });
  protected readonly archivedClash = computed(() => {
    const hit = this.catalog.find(this.query());
    return hit?.archived && !this.picked().has(hit.id) ? hit : null;
  });
  protected readonly nextColor = computed(() => this.catalog.nextColor());

  protected isOn(id: string): boolean {
    return this.picked().has(id);
  }

  protected usageOf(id: string): number {
    return this.catalog.usageOf(id).total;
  }

  protected onState(next: 'open' | 'closed'): void {
    this.state.set(next);
    if (next === 'closed') this.query.set('');
  }

  close(): void {
    this.onState('closed');
  }

  /** Open the list (keyboard shortcut). Clicks the trigger so the popover anchors to it. */
  open(): void {
    if (!this.disabled() && this.state() !== 'open') this.trigger()?.nativeElement.click();
  }

  protected toggle(label: WorkspaceLabel): void {
    const current = this.value();
    if (current.includes(label.id)) {
      this.valueChange.emit(current.filter((id) => id !== label.id));
      return;
    }
    if (this.atMax()) return;
    this.catalog.touch(label.id);
    this.valueChange.emit([...current, label.id]);
  }

  /** The command list only knows items that exist when the search changes, so a fresh "Create" row is not active yet. */
  protected onEnter(): void {
    const name = this.createName();
    if (name && !this.hasMatch()) void this.create(name);
  }

  protected async create(name: string): Promise<void> {
    if (this.busy() || this.atMax()) return;
    this.busy.set(true);
    const made = await this.catalog.create(name);
    this.busy.set(false);
    if (!made) return;
    this.query.set('');
    this.catalog.touch(made.id);
    this.valueChange.emit([...this.value(), made.id]);
  }
}
