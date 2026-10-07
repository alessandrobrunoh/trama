// Small presentational pieces shared by list rows, board cards and the detail screens.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import {
  LucideCalendar,
  LucideCheck,
  LucideDynamicIcon,
  LucideEye,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, isOverdue, shortDate, type Artifact, type Workstream } from '../../core';
import { ActorAvatar, AvatarStack } from '../../shared/actor-avatar';
import { ArtifactIcon } from '../../shared/artifact';
import { StatusIcon } from '../../shared/status';

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
  private readonly store = inject(NablaStore);
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
    @if (date(); as d) {
      <svg [lucideIcon]="cal" [size]="12"></svg>{{ label() }}
    } @else {
      <span class="text-muted-foreground/50">—</span>
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
