// Small presentational pieces shared by list rows, board cards and the detail screens.
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import {
  LucideCalendar,
  LucideCheck,
  LucideDynamicIcon,
  LucideEye,
  LucideListChecks,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCalendar } from '@spartan-ng/helm/calendar';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, isOverdue, shortDate, type Artifact, type Workstream } from '../../core';
import { ActorAvatar, AvatarStack } from '../../shared/actor-avatar';
import { ArtifactIcon } from '../../shared/artifact';
import { StatusIcon } from '../../shared/status';
import { statusSourceInfo } from './status-source';

/** "pinned" / "historic" next to a status; nothing for a derived one. */
@Component({
  selector: 'app-status-source-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: { class: 'inline-flex shrink-0' },
  template: `
    @if (ws().statusSource !== 'derived') {
      <span
        class="text-muted-foreground bg-muted rounded-full px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap"
        [hlmTooltip]="info().hint"
        position="bottom"
        >{{ info().label }}</span
      >
    }
  `,
})
export class StatusSourceBadge {
  readonly ws = input.required<Pick<Workstream, 'statusSource' | 'derivedStatus'>>();
  protected readonly info = computed(() => statusSourceInfo(this.ws()));
}

/** Compact PR / MR chip: `#182 ● ✓` (CI, review, conflicts). */
@Component({
  selector: 'app-pr-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ArtifactIcon, StatusIcon, LucideDynamicIcon, HlmTooltip],
  host: {
    class:
      'bg-background inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs whitespace-nowrap',
  },
  template: `
   <span class="inline-flex items-center gap-1" [hlmTooltip]="tip()" position="bottom">
    <app-artifact-icon [kind]="artifact().kind" [state]="artifact().state" [size]="12" />
    <span class="font-mono text-[11px]">{{ artifact().externalId || 'PR' }}</span>
    @if (artifact().ci; as ci) {
      <app-status-icon [status]="ci" [size]="11" />
    }
    @switch (artifact().review) {
      @case ('approved') {
        <svg [lucideIcon]="check" [size]="12" class="text-status-passing"></svg>
      }
      @case ('changes_requested') {
        <svg [lucideIcon]="x" [size]="12" class="text-status-failing"></svg>
      }
      @case ('requested') {
        <svg [lucideIcon]="eye" [size]="12" class="text-status-pending"></svg>
      }
    }
    @if (artifact().hasConflicts) {
      <svg [lucideIcon]="alert" [size]="12" class="text-status-blocked"></svg>
    }
   </span>
  `,
})
export class PrChip {
  readonly artifact = input.required<Artifact>();
  protected readonly check = LucideCheck;
  protected readonly x = LucideX;
  protected readonly eye = LucideEye;
  protected readonly alert = LucideTriangleAlert;
  protected readonly tip = computed(() => {
    const a = this.artifact();
    const bits = [a.title, `state ${a.state}`];
    if (a.ci) bits.push(`CI ${a.ci}`);
    if (a.review && a.review !== 'none') bits.push(`review ${a.review.replace('_', ' ')}`);
    if (a.hasConflicts) bits.push('has conflicts');
    return bits.join(' · ');
  });
}

/** Mini progress bar: met (solid) + in-progress (soft) of total criteria. */
@Component({
  selector: 'app-criteria-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: {
    class: 'inline-flex items-center',
  },
  template: `
   <span class="inline-flex items-center gap-1.5" [hlmTooltip]="tip()" position="bottom">
    @if (total() > 0) {
      <span class="bg-muted flex h-1 w-12 overflow-hidden rounded-full">
        <span class="bg-status-shipped h-full" [style.width.%]="(met() / total()) * 100"></span>
        <span class="bg-status-working/50 h-full" [style.width.%]="(inProgress() / total()) * 100"></span>
      </span>
      <span class="text-muted-foreground text-xs tabular-nums">{{ met() }}/{{ total() }}</span>
    } @else {
      <span class="text-muted-foreground/60 text-xs">No criteria</span>
    }
   </span>
  `,
})
export class CriteriaBar {
  readonly met = input(0);
  readonly inProgress = input(0);
  readonly total = input(0);
  protected readonly tip = computed(
    () => `${this.met()} of ${this.total()} acceptance criteria met${this.inProgress() ? `, ${this.inProgress()} in progress` : ''}`,
  );
}

/** Owner team avatar + overlapped participating teams. */
@Component({
  selector: 'app-team-dots',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar, AvatarStack, HlmTooltip],
  host: { class: 'inline-flex items-center' },
  template: `
   <span class="inline-flex items-center gap-1" [hlmTooltip]="tip()" position="bottom">
    <app-actor-avatar [actor]="{ type: 'team', id: ws().ownerTeamId }" [size]="18" />
    @if (participants().length) {
      <app-avatar-stack [actors]="participants()" [max]="3" [size]="14" />
    }
   </span>
  `,
})
export class TeamDots {
  private readonly store = inject(TramaStore);
  readonly ws = input.required<Workstream>();
  protected readonly participants = computed(() =>
    this.ws().participatingTeamIds.map((id) => ({ type: 'team' as const, id })),
  );
  protected readonly tip = computed(() => {
    const w = this.ws();
    const owner = this.store.getTeam(w.ownerTeamId)?.name ?? 'Unknown';
    const rest = w.participatingTeamIds.map((id) => this.store.getTeam(id)?.name).filter(Boolean);
    return rest.length ? `Owner: ${owner} · with ${rest.join(', ')}` : `Owner: ${owner}`;
  });
}

/** Target date; red when overdue (unless the workstream is finished). */
@Component({
  selector: 'app-target-date',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: {
    class: 'inline-flex items-center gap-1 text-xs whitespace-nowrap tabular-nums',
    '[class.text-status-blocked]': 'overdue()',
    '[class.text-muted-foreground]': '!overdue()',
  },
  template: `
    @if (date()) {
      <svg [lucideIcon]="cal" [size]="12"></svg>{{ label() }}
    }
  `,
})
export class TargetDate {
  readonly date = input<string>();
  readonly done = input(false);
  protected readonly cal = LucideCalendar;
  protected readonly overdue = computed(() => !this.done() && isOverdue(this.date()));
  protected readonly label = computed(() => shortDate(this.date()));
}

/**
 * Issue progress of a workstream: a ring (issues are circles) + "done/total".
 * Deliberately different from the acceptance-criteria count (a checklist icon).
 */
@Component({
  selector: 'app-issue-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: { class: 'inline-flex items-center' },
  template: `
    <span class="inline-flex items-center gap-1.5 text-xs whitespace-nowrap tabular-nums" [hlmTooltip]="tip()" position="bottom">
      @if (total() > 0) {
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="var(--border-strong)" stroke-width="2" />
          @if (active() > 0) {
            <circle cx="8" cy="8" r="6" stroke="var(--status-working)" stroke-opacity="0.45" stroke-width="2"
              [attr.stroke-dasharray]="arc(done() + active()) + ' 40'" transform="rotate(-90 8 8)" />
          }
          @if (done() > 0) {
            <circle cx="8" cy="8" r="6" stroke="var(--status-shipped)" stroke-width="2" stroke-linecap="round"
              [attr.stroke-dasharray]="arc(done()) + ' 40'" transform="rotate(-90 8 8)" />
          }
        </svg>
        <span [class.text-muted-foreground]="done() < total()">{{ done() }}/{{ total() }}</span>
        @if (!compact()) {
          <span class="text-muted-foreground">issues</span>
        }
      } @else if (!compact()) {
        <span class="text-muted-foreground/60">No issues</span>
      }
    </span>
  `,
})
export class IssueProgress {
  readonly done = input(0);
  readonly active = input(0);
  readonly total = input(0);
  /** Hide the "issues" word. */
  readonly compact = input(false);
  private readonly circumference = 2 * Math.PI * 6;
  protected arc(n: number): string {
    return ((Math.min(n, this.total()) / Math.max(1, this.total())) * this.circumference).toFixed(2);
  }
  protected readonly tip = computed(() =>
    this.total()
      ? `${this.done()} of ${this.total()} linked issues done${this.active() ? `, ${this.active()} in progress` : ''}`
      : 'No issues linked yet',
  );
}

/** Compact acceptance-criteria count: checklist icon + met/total. */
@Component({
  selector: 'app-criteria-count',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip, LucideDynamicIcon],
  host: { class: 'inline-flex items-center' },
  template: `
    @if (total() > 0) {
      <span
        class="inline-flex items-center gap-1 text-xs whitespace-nowrap tabular-nums"
        [class.text-muted-foreground]="met() < total()"
        [class.text-status-shipped]="met() === total()"
        [hlmTooltip]="met() + ' of ' + total() + ' acceptance criteria met'"
        position="bottom"
      >
        <svg [lucideIcon]="icon" [size]="13"></svg>{{ met() }}/{{ total() }}
      </span>
    }
  `,
})
export class CriteriaCount {
  readonly met = input(0);
  readonly total = input(0);
  protected readonly icon = LucideListChecks;
}

/**
 * Target-date editor: the projected content is the trigger; the popover offers quick presets,
 * a calendar and "Clear". Emits a local calendar day (or null).
 */
@Component({
  selector: 'app-ws-date-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmPopoverImports, HlmCalendar, HlmButtonImports],
  host: { class: 'inline-flex min-w-0' },
  template: `
    <hlm-popover [align]="align()" sideOffset="4" [state]="state()" (stateChanged)="state.set($event)">
      <button
        hlmPopoverTrigger
        type="button"
        class="focus-visible:ring-ring hover:bg-accent inline-flex min-w-0 items-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none"
        [class]="triggerClass()"
        [disabled]="disabled()"
        [attr.aria-label]="label()"
      >
        <ng-content />
      </button>
      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-fit gap-0 p-0">
        <div class="grid grid-cols-2 gap-0.5 border-b p-1">
          @for (p of presets; track p.label) {
            <button hlmBtn variant="ghost" size="xs" class="justify-start font-normal" (click)="pick(p.at())">{{ p.label }}</button>
          }
        </div>
        <hlm-calendar class="border-0" [date]="date()" [weekStartsOn]="store.weekStartsOn()" (dateChange)="pick($event)" />
        @if (value()) {
          <div class="border-t p-1">
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground w-full" (click)="pick(null)">Clear date</button>
          </div>
        }
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class WsDatePicker {
  protected readonly store = inject(TramaStore);
  /** Current ISO date (or undefined). */
  readonly value = input<string | undefined>();
  readonly disabled = input(false);
  readonly label = input('Target date');
  readonly triggerClass = input('');
  readonly align = input<'start' | 'center' | 'end'>('start');
  readonly dateChange = output<Date | null>();

  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly date = computed(() => {
    const v = this.value();
    return v ? new Date(v) : undefined;
  });
  protected readonly presets: { label: string; at: () => Date }[] = [
    { label: 'Today', at: () => plusDays(0) },
    { label: 'Tomorrow', at: () => plusDays(1) },
    { label: 'Next week', at: () => plusDays(7) },
    { label: 'In 2 weeks', at: () => plusDays(14) },
  ];

  open(): void {
    if (!this.disabled()) this.state.set('open');
  }

  protected pick(d: Date | null | undefined): void {
    this.state.set('closed');
    this.dateChange.emit(d ?? null);
  }
}

function plusDays(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}
