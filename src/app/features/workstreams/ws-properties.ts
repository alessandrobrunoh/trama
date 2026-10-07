// Properties sidebar of a workstream: every row is an inline popover editor.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideDynamicIcon, LucidePlus, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { NablaStore, isOverdue, type Priority, type Workstream } from '../../core';
import { PropertyRow } from '../../shared/property-row';
import { Picker } from './picker';
import { priorityOptions, repoOptions, teamOptions, userOptions } from './ws-model';

@Component({
  selector: 'app-ws-properties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PropertyRow,
    Picker,
    HlmButtonImports,
    HlmDatePickerImports,
    HlmInputImports,
    HlmPopoverImports,
    LucideDynamicIcon,
  ],
  host: { class: 'block' },
  template: `
    @let w = ws();
    <div class="flex flex-col gap-0.5">
      <app-property-row label="Owner team">
        <app-picker variant="field" label="Owner team" [disabled]="!canEdit()" [options]="teams()" [value]="[w.ownerTeamId]" (valueChange)="setOwner($event[0])" />
      </app-property-row>
      <app-property-row label="Participating">
        <app-picker variant="field" label="Participating teams" placeholder="None" [multiple]="true" [disabled]="!canEdit()" [options]="participantOptions()" [value]="w.participatingTeamIds" (valueChange)="update({ participatingTeamIds: $event })" />
      </app-property-row>
      <app-property-row label="Accountable">
        <app-picker variant="field" label="Accountable" placeholder="Unassigned" [clearable]="true" clearLabel="Unassign" [disabled]="!canEdit()" [options]="users()" [value]="w.accountableUserId ? [w.accountableUserId] : []" (valueChange)="update({ accountableUserId: $event[0] ?? null })" />
      </app-property-row>
      <app-property-row label="Priority">
        <app-picker variant="field" label="Priority" [searchable]="false" [disabled]="!canEdit()" [options]="priorities" [value]="[w.priority]" (valueChange)="setPriority($event[0])" />
      </app-property-row>
      <app-property-row label="Target date">
        <hlm-date-picker [date]="date()" (dateChange)="setDate($event)" align="start" class="min-w-0 flex-1" [disabled]="!canEdit()">
          <hlm-date-picker-trigger variant="ghost" [showTrigger]="false" class="block w-full [&>button]:h-auto [&>button]:min-h-8 [&>button]:w-full [&>button]:justify-start [&>button]:px-1.5 [&>button]:font-normal" [class.text-status-blocked]="overdue()">
            No date
          </hlm-date-picker-trigger>
          @if (w.targetDate && canEdit()) {
            <div hlmDatePickerFooter class="border-t p-1.5">
              <button hlmBtn variant="ghost" size="sm" class="w-full" (click)="setDate(null)">Clear date</button>
            </div>
          }
        </hlm-date-picker>
      </app-property-row>
      <app-property-row label="Repositories">
        <app-picker variant="field" label="Repositories" placeholder="None" [multiple]="true" [disabled]="!canEdit()" [options]="repos()" [value]="w.repositoryIds" (valueChange)="update({ repositoryIds: $event })" />
      </app-property-row>
      <app-property-row label="Labels">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1">
          @for (l of w.labels; track l) {
            <span class="bg-muted text-foreground inline-flex h-5 items-center gap-0.5 rounded-md px-1.5 text-xs">
              {{ l }}
              @if (canEdit()) {
                <button type="button" class="text-muted-foreground hover:text-foreground -mr-0.5 rounded" [attr.aria-label]="'Remove label ' + l" (click)="removeLabel(l)">
                  <svg [lucideIcon]="xIcon" [size]="11"></svg>
                </button>
              }
            </span>
          }
          @if (canEdit()) {
            <hlm-popover align="start" sideOffset="4" [state]="labelState()" (stateChanged)="labelState.set($event)">
              <button hlmBtn hlmPopoverTrigger variant="ghost" size="xs" class="text-muted-foreground h-5 px-1.5 text-xs font-normal" aria-label="Add label">
                <svg [lucideIcon]="plusIcon" [size]="12"></svg>{{ w.labels.length ? '' : 'Add label' }}
              </button>
              <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-56 gap-1.5 p-2">
                <input hlmInput class="h-8" placeholder="Label name, Enter to add" aria-label="New label" [value]="labelDraft()" (input)="labelDraft.set($any($event.target).value)" (keydown.enter)="addLabel()" />
                @if (suggestions().length) {
                  <div class="text-muted-foreground text-[11px]">Existing labels</div>
                  <div class="flex flex-wrap gap-1">
                    @for (s of suggestions(); track s) {
                      <button type="button" class="bg-muted hover:bg-accent rounded-md px-1.5 py-0.5 text-xs" (click)="addLabel(s)">{{ s }}</button>
                    }
                  </div>
                }
              </hlm-popover-content>
            </hlm-popover>
          }
        </div>
      </app-property-row>
    </div>
  `,
})
export class WsProperties {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly repos = computed(() => repoOptions(this.store));
  protected readonly priorities = priorityOptions();
  protected readonly participantOptions = computed(() => this.teams().filter((t) => t.value !== this.ws().ownerTeamId));
  protected readonly xIcon = LucideX;
  protected readonly plusIcon = LucidePlus;
  protected readonly labelState = signal<'open' | 'closed'>('closed');
  protected readonly labelDraft = signal('');

  protected readonly date = computed(() => {
    const d = this.ws().targetDate;
    return d ? new Date(d) : undefined;
  });
  protected readonly overdue = computed(
    () => isOverdue(this.ws().targetDate) && this.ws().status !== 'shipped' && this.ws().status !== 'canceled',
  );
  protected readonly suggestions = computed(() => {
    const have = new Set(this.ws().labels);
    const all = new Set<string>();
    for (const w of this.store.workstreams()) for (const l of w.labels) if (!have.has(l)) all.add(l);
    return [...all].sort().slice(0, 12);
  });

  protected update(patch: Parameters<NablaStore['updateWorkstream']>[1]): void {
    void this.store.updateWorkstream(this.ws().id, patch);
  }

  protected setOwner(id: string | undefined): void {
    if (!id || id === this.ws().ownerTeamId) return;
    this.update({ ownerTeamId: id, participatingTeamIds: this.ws().participatingTeamIds.filter((t) => t !== id) });
  }

  protected setPriority(p: string | undefined): void {
    if (p) this.update({ priority: p as Priority });
  }

  protected setDate(d: Date | null | undefined): void {
    if (!d) this.update({ targetDate: null });
    else this.update({ targetDate: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString() });
  }

  protected addLabel(value?: string): void {
    const l = (value ?? this.labelDraft()).trim();
    if (!l) return;
    this.labelDraft.set('');
    if (!this.ws().labels.includes(l)) this.update({ labels: [...this.ws().labels, l] });
  }

  protected removeLabel(l: string): void {
    this.update({ labels: this.ws().labels.filter((x) => x !== l) });
  }
}
