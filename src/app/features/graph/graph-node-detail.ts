import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowUpRight, LucideDynamicIcon, LucidePlus, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  ARTIFACT_KIND_META,
  NablaStore,
  Notifier,
  type Artifact,
  type Workstream,
} from '../../core';
import { ActorLabel, AvatarStack } from '../../shared/actor-avatar';
import { ArtifactIcon, CiChip, ConflictChip, ReviewChip } from '../../shared/artifact';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { ProviderIcon } from '../../shared/provider-icon';
import { PropertyRow } from '../../shared/property-row';
import { ShortDatePipe } from '../../shared/pipes';
import { StatusBadge, StatusIcon, type AnyStatus } from '../../shared/status';
import { Picker } from '../workstreams/picker';
import { workstreamOptions } from '../workstreams/ws-model';
import type { GraphNode } from './graph-model';

/** A neighbour in the dependency list of the detail panel. */
export interface DetailLink {
  id: string;
  label: string;
  status?: AnyStatus;
  mono?: boolean;
  blocking?: boolean;
}

/** Body of the graph's side sheet: details + links for one node. */
@Component({
  selector: 'app-graph-node-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    ActorLabel,
    AvatarStack,
    ArtifactIcon,
    CiChip,
    ReviewChip,
    ConflictChip,
    KeyChip,
    PriorityIcon,
    ProviderIcon,
    PropertyRow,
    ShortDatePipe,
    StatusBadge,
    StatusIcon,
    Picker,
  ],
  template: `
    @let n = node();
    @switch (n.kind) {
      @case ('workstream') {
        @let w = ws();
        <div class="flex flex-col gap-3">
          <div class="flex min-w-0 items-center gap-2">
            <app-status-icon entity="workstream" [status]="w.status" [size]="16" />
            <app-key-chip [value]="w.key" />
            <app-status-badge entity="workstream" [status]="w.status" />
          </div>
          <h3 class="text-base leading-snug font-medium">{{ w.title }}</h3>
          @if (w.objective) {
            <p class="text-muted-foreground line-clamp-4 text-sm">{{ w.objective }}</p>
          }
        </div>
        <div class="mt-3 flex flex-col">
          <app-property-row label="Owner team">
            @if (ownerTeam(); as t) {
              <app-actor [actor]="{ type: 'team', id: t.id }" [size]="16" />
            }
          </app-property-row>
          @if (w.participatingTeamIds.length) {
            <app-property-row label="Participating">
              <app-avatar-stack [actors]="participating()" [max]="5" [size]="18" />
            </app-property-row>
          }
          @if (w.accountableUserId) {
            <app-property-row label="Accountable">
              <app-actor [actor]="{ type: 'user', id: w.accountableUserId }" [size]="16" />
            </app-property-row>
          }
          <app-property-row label="Priority"><app-priority-icon [priority]="w.priority" showLabel /></app-property-row>
          @if (w.targetDate) {
            <app-property-row label="Target"><span>{{ w.targetDate | shortDate }}</span></app-property-row>
          }
          <app-property-row label="Criteria">
            <span>{{ criteriaMet() }} of {{ w.acceptanceCriteria.length }} met</span>
          </app-property-row>
          @if (w.deltaThreadUrl && deltaEnabled()) {
            <app-property-row label="Delta">
              <a class="truncate text-xs hover:underline" [href]="w.deltaThreadUrl" target="_blank" rel="noopener noreferrer">Thread</a>
            </app-property-row>
          }
        </div>
        <a hlmBtn variant="outline" size="sm" class="mt-4 w-fit" [routerLink]="['/', slug(), 'workstreams', w.key]">
          Open workstream <svg [lucideIcon]="arrow" [size]="13"></svg>
        </a>
      }
      @case ('artifact') {
        @let a = art();
        <div class="flex flex-col gap-3">
          <div class="flex min-w-0 items-center gap-2">
            <app-artifact-icon [kind]="a.kind" [state]="a.state" [size]="16" />
            <span class="text-muted-foreground text-xs">{{ kindLabel() }}</span>
            @if (a.externalId) {
              <app-key-chip [value]="a.externalId" />
            }
          </div>
          <h3 class="text-base leading-snug font-medium">{{ a.title }}</h3>
          <div class="flex flex-wrap items-center gap-1.5">
            <app-status-badge [status]="a.state" />
            @if (a.ci) {
              <app-ci-chip [ci]="a.ci" />
            }
            @if (a.review) {
              <app-review-chip [review]="a.review" />
            }
            @if (a.hasConflicts) {
              <app-conflict-chip />
            }
          </div>
        </div>
        <div class="mt-3 flex flex-col">
          @if (a.environment) {
            <app-property-row label="Environment"><span class="font-mono text-xs">{{ a.environment }}</span></app-property-row>
          }
          @if (artifactRepo(); as r) {
            <app-property-row label="Repository">
              <a class="inline-flex min-w-0 items-center gap-1.5 hover:underline" [routerLink]="['/', slug(), 'repositories', r.id]">
                <app-provider-icon [provider]="r.provider" [size]="13" />
                <span class="truncate font-mono text-xs">{{ r.fullName }}</span>
              </a>
            </app-property-row>
          }
          @if (a.authorRef) {
            <app-property-row label="Author"><app-actor [actor]="a.authorRef" [size]="16" /></app-property-row>
          }
          @if (parentWs(); as p) {
            <app-property-row label="Workstream"><app-key-chip [value]="p.key" /></app-property-row>
          }
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          @if (a.url) {
            <a hlmBtn variant="outline" size="sm" [href]="a.url" target="_blank" rel="noopener noreferrer">
              Open {{ a.provider }} <svg [lucideIcon]="arrow" [size]="13"></svg>
            </a>
          }
          @if (parentWs(); as p) {
            <a hlmBtn variant="ghost" size="sm" [routerLink]="['/', slug(), 'workstreams', p.key]">
              Workstream <svg [lucideIcon]="arrow" [size]="13"></svg>
            </a>
          }
        </div>
      }
    }

    @if (blockedBy().length) {
      <div class="mt-5">
        <div class="text-muted-foreground mb-1 text-xs font-medium">Waiting on</div>
        @if (hasBlockingDependency()) {
          <p class="text-blocked mb-1.5 text-xs">This workstream is blocked until the listed workstreams ship.</p>
        }
        <div class="flex flex-col">
          @for (l of blockedBy(); track l.id) {
            <ng-container *ngTemplateOutlet="linkRow; context: { $implicit: l }" />
          }
        </div>
      </div>
    }
    @if (blocks().length) {
      <div class="mt-4">
        <div class="text-muted-foreground mb-1 text-xs font-medium">Blocks</div>
        <div class="flex flex-col">
          @for (l of blocks(); track l.id) {
            <ng-container *ngTemplateOutlet="linkRow; context: { $implicit: l }" />
          }
        </div>
      </div>
    }

    @if (node().kind === 'workstream' && canEdit()) {
      <div class="mt-5 flex flex-wrap items-center gap-1.5 border-t pt-3">
        <span class="text-muted-foreground mr-1 text-xs">Add dependency</span>
        <app-picker
          variant="bare"
          label="Waits on…"
          searchPlaceholder="Search workstreams…"
          triggerClass="h-7 gap-1 border border-border-strong px-2 text-xs"
          [options]="candidates()"
          [value]="[]"
          (valueChange)="addDep('waits', $event[0])"
        >
          <svg [lucideIcon]="plusIcon" [size]="12"></svg>Waits on
        </app-picker>
        <app-picker
          variant="bare"
          label="Blocks…"
          searchPlaceholder="Search workstreams…"
          triggerClass="h-7 gap-1 border border-border-strong px-2 text-xs"
          [options]="candidates()"
          [value]="[]"
          (valueChange)="addDep('blocks', $event[0])"
        >
          <svg [lucideIcon]="plusIcon" [size]="12"></svg>Blocks
        </app-picker>
      </div>
    }

    <ng-template #linkRow let-l>
      <div class="group/dep flex items-center">
        <button
          hlmBtn
          type="button"
          variant="ghost"
          size="sm"
          class="h-8 min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal"
          (click)="focusNode.emit(l.id)"
        >
          @if (l.status) {
            <app-status-icon entity="workstream" [status]="l.status" />
          }
          <span class="truncate" [class.font-mono]="l.mono" [class.text-xs]="l.mono">{{ l.label }}</span>
          @if (l.status === 'shipped') {
            <span class="text-muted-foreground ml-auto shrink-0 text-[10px]">Shipped</span>
          } @else if (l.blocking) {
            <span class="text-blocked ml-auto shrink-0 text-[10px] font-medium">Blocking</span>
          }
        </button>
        @if (canEdit() && depId(l.id); as dep) {
          <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground opacity-0 group-hover/dep:opacity-100 focus-visible:opacity-100" aria-label="Remove dependency" (click)="removeDep(dep)">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>
          </button>
        }
      </div>
    </ng-template>
  `,
})
export class GraphNodeDetail {
  private readonly store = inject(NablaStore);
  protected readonly deltaEnabled = computed(() => this.store.deltaThreads());
  readonly node = input.required<GraphNode>();
  readonly blockedBy = input<readonly DetailLink[]>([]);
  readonly blocks = input<readonly DetailLink[]>([]);
  readonly focusNode = output<string>();

  protected hasBlockingDependency(): boolean {
    return this.blockedBy().some((dependency) => dependency.blocking);
  }

  private readonly notify = inject(Notifier);
  protected readonly arrow = LucideArrowUpRight;
  protected readonly plusIcon = LucidePlus;
  protected readonly xIcon = LucideX;
  protected readonly canEdit = computed(() => this.store.can('member'));
  /** Workstreams that can become a dependency of this node. */
  protected readonly candidates = computed(() => {
    const n = this.node();
    if (n.kind !== 'workstream') return [];
    const linked = new Set<string>([n.id]);
    for (const d of this.store.dependencies()) {
      if (d.fromId === n.id) linked.add(d.toId);
      if (d.toId === n.id) linked.add(d.fromId);
    }
    return workstreamOptions(this.store.workstreams().filter((w) => !linked.has(w.id) && w.status !== 'canceled'));
  });

  /** The dependency between this node and `otherId`, either direction. */
  protected depId(otherId: string): string | undefined {
    const id = this.node().id;
    return this.store.dependencies().find((d) => (d.fromId === id && d.toId === otherId) || (d.fromId === otherId && d.toId === id))?.id;
  }

  protected async addDep(kind: 'waits' | 'blocks', otherId: string | undefined): Promise<void> {
    if (!otherId) return;
    const me = this.node().id;
    const [fromId, toId] = kind === 'waits' ? [otherId, me] : [me, otherId];
    const dep = await this.store.addDependency({ fromType: 'workstream', fromId, toType: 'workstream', toId });
    if (dep) this.notify.success('Dependency added', { action: { label: 'Undo', run: () => void this.store.removeDependency(dep.id) } });
  }

  protected removeDep(id: string): void {
    const d = this.store.dependencies().find((x) => x.id === id);
    if (!d) return;
    void this.store.removeDependency(id);
    const { fromType, fromId, toType, toId } = d;
    this.notify.success('Dependency removed', { action: { label: 'Undo', run: () => void this.store.addDependency({ fromType, fromId, toType, toId }) } });
  }
  protected readonly slug = this.store.slug;

  protected readonly ws = computed(() => this.node().entity as Workstream);
  protected readonly art = computed(() => this.node().entity as Artifact);

  protected readonly ownerTeam = computed(() => this.store.teamById().get(this.ws().ownerTeamId));
  protected readonly participating = computed(() =>
    this.ws().participatingTeamIds.map((id) => ({ type: 'team' as const, id })),
  );
  protected readonly criteriaMet = computed(() => this.ws().acceptanceCriteria.filter((c) => c.state === 'met').length);
  protected readonly kindLabel = computed(() => ARTIFACT_KIND_META[this.art().kind].label);
  protected readonly parentWs = computed(() => {
    const n = this.node();
    if (n.kind === 'workstream') return undefined;
    return this.store.workstreamById().get(n.entity.workstreamId);
  });
  protected readonly artifactRepo = computed(() => {
    const id = this.art().repositoryId;
    return id ? this.store.repositoryById().get(id) : undefined;
  });
}
