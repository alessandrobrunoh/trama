import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideCheck,
  LucideCopy,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideLink2,
  LucidePlus,
  LucideReplace,
  LucideScale,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { Clipboard, DECISION_STATUS_META, NablaStore, Notifier, UiStore } from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorLabel } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { EntityChip } from '../../shared/entity-chip';
import { KeyChip } from '../../shared/key-chip';
import { FullDatePipe, RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { StatusIcon } from '../../shared/status';
import { EntityPicker, type PickOption as EntityOption } from '../views/option-controls';
import { CommentThread } from '../workstreams/comments';
import { EditableMarkdown, InlineText } from '../workstreams/inline-edit';
import { DecisionTags } from './decision-tags';

/** Status-specific one-liner under the title. */
const STATUS_HINT: Record<string, string> = {
  draft: 'Draft — finish it when you are ready to share the decision.',
  proposed: 'Proposed — waiting for someone to accept or reject it.',
  accepted: 'Accepted — this is how we do it now.',
  superseded: 'Superseded — kept for history; a newer decision replaces it.',
  rejected: 'Rejected — considered and turned down.',
};

@Component({
  selector: 'app-decision-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    TopBarActions,
    ActorLabel,
    EmptyState,
    EntityChip,
    KeyChip,
    RelativeTimePipe,
    FullDatePipe,
    PropertyRow,
    StatusIcon,
    CommentThread,
    InlineText,
    EditableMarkdown,
    EntityPicker,
    DecisionTags,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (decision(); as d) {
      <ng-template appTopBarActions>
        @if (canEdit() && d.status === 'draft') {
          <button hlmBtn size="sm" [disabled]="!d.statement.trim()" (click)="proposeDraft()">
            Propose decision
          </button>
        }
        @if (canDecide() && d.status === 'proposed') {
          <button hlmBtn size="sm" (click)="accept()">
            <svg [lucideIcon]="checkIcon" [size]="14"></svg>
            Accept
          </button>
          <button hlmBtn size="sm" variant="outline" (click)="reject()">
            <svg [lucideIcon]="xIcon" [size]="14"></svg>
            Reject
          </button>
        }
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="more"
          aria-label="Decision actions"
        >
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-52">
            <button hlmDropdownMenuItem (triggered)="copyLink()">
              <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy link
            </button>
            <button hlmDropdownMenuItem (triggered)="copyKey()">
              <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy key
            </button>
            @if (canEdit()) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete decision
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <div
        class="mx-auto grid w-full max-w-[1200px] gap-x-10 gap-y-6 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_17rem]"
      >
        <div class="flex min-w-0 flex-col gap-7">
          <header class="flex flex-col gap-2">
            <div class="flex items-center gap-2 text-xs">
              <app-key-chip [value]="d.key" />
              <span
                class="border-border-strong text-foreground/85 inline-flex h-5 items-center gap-1 rounded-full border px-1.5 font-medium"
              >
                <app-status-icon [status]="d.status" entity="other" [size]="12" />
                {{ statusLabel() }}
              </span>
              @if (supersededBy(); as next) {
                <span class="text-muted-foreground">by</span>
                <app-entity-chip type="decision" [ref]="next.id" compact />
              }
            </div>
            <app-inline-text
              class="-mx-1.5"
              label="title"
              textClass="text-xl font-semibold tracking-tight"
              [value]="d.title"
              [canEdit]="canEdit()"
              (save)="saveTitle($event)"
            />
            <p class="text-meta">{{ statusHint() }}</p>
            @if (canDecide() && d.status === 'proposed') {
              <div
                class="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm"
              >
                <app-status-icon status="proposed" entity="other" />
                <span class="min-w-0 flex-1">This decision is waiting for a call.</span>
                <button hlmBtn size="sm" variant="outline" (click)="accept()">Accept</button>
                <button hlmBtn size="sm" variant="ghost" (click)="reject()">Reject</button>
              </div>
            }
          </header>

          <section>
            <h2 class="text-muted-foreground mb-1 text-xs font-medium">Decision</h2>
            <app-editable-markdown
              label="statement"
              placeholder="What was decided?"
              [value]="d.statement"
              [canEdit]="canEdit()"
              (save)="saveStatement($event)"
            />
          </section>
          <section>
            <h2 class="text-muted-foreground mb-1 text-xs font-medium">Rationale</h2>
            <app-editable-markdown
              label="rationale"
              placeholder="Why this, and not the alternative?"
              [value]="d.rationale ?? ''"
              [canEdit]="canEdit()"
              (save)="saveRationale($event)"
            />
          </section>
          <section class="border-t pt-5">
            <h2 class="mb-2 text-sm font-medium">Activity</h2>
            <app-comment-thread [subject]="{ type: 'decision', id: d.id }" />
          </section>
        </div>

        <aside class="flex flex-col gap-5 lg:border-s lg:ps-6">
          <div class="flex flex-col gap-0.5">
            <app-property-row label="Status">
              <span class="flex items-center gap-1.5 px-1.5 text-sm">
                <app-status-icon [status]="d.status" entity="other" />
                {{ statusLabel() }}
              </span>
            </app-property-row>
            <app-property-row label="Proposed by">
              <span class="px-1.5"><app-actor [actor]="d.proposedBy" [size]="18" /></span>
            </app-property-row>
            @if (d.decidedById) {
              <app-property-row label="Decided by">
                <span class="flex items-center gap-2 px-1.5">
                  <app-actor [actor]="{ type: 'user', id: d.decidedById }" [size]="18" />
                  @if (d.decidedAt) {
                    <span
                      class="text-meta"
                      [hlmTooltip]="d.decidedAt | fullDate"
                      position="bottom"
                      >{{ d.decidedAt | relativeTime }}</span
                    >
                  }
                </span>
              </app-property-row>
            }
          </div>

          <section class="flex flex-col gap-2">
            <h3 class="text-muted-foreground text-xs font-medium">Origin workstream</h3>
            <div class="flex flex-wrap items-center gap-1.5">
              @if (d.originWorkstreamId) {
                <span class="inline-flex max-w-full items-center gap-0.5">
                  <app-entity-chip type="workstream" [ref]="d.originWorkstreamId" class="min-w-0" />
                  @if (canEdit()) {
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 shrink-0 items-center justify-center rounded-full"
                      aria-label="Clear origin workstream"
                      (click)="setOrigin(null)"
                    >
                      <svg [lucideIcon]="xIcon" [size]="11"></svg>
                    </button>
                  }
                </span>
              } @else if (!canEdit()) {
                <span class="text-muted-foreground text-sm">None</span>
              }
              @if (canEdit()) {
                <app-entity-picker
                  variant="ghost"
                  size="xs"
                  placeholder="Where was this decided?"
                  emptyText="No workstreams."
                  [options]="originCandidates()"
                  (picked)="setOrigin($event)"
                >
                  <span class="text-muted-foreground text-xs">{{
                    d.originWorkstreamId ? 'Change' : '+ Set origin'
                  }}</span>
                </app-entity-picker>
              }
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-muted-foreground text-xs font-medium">Related workstreams</h3>
            <div class="flex flex-wrap items-center gap-1.5">
              @for (id of d.relatedWorkstreamIds; track id) {
                <span class="inline-flex max-w-full items-center gap-0.5">
                  <app-entity-chip type="workstream" [ref]="id" class="min-w-0" />
                  @if (canEdit()) {
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 shrink-0 items-center justify-center rounded-full"
                      [attr.aria-label]="'Remove related workstream'"
                      (click)="removeRelated(id)"
                    >
                      <svg [lucideIcon]="xIcon" [size]="11"></svg>
                    </button>
                  }
                </span>
              } @empty {
                @if (!canEdit()) {
                  <span class="text-muted-foreground text-sm">None</span>
                }
              }
              @if (canEdit() && relatedCandidates().length) {
                <app-entity-picker
                  variant="ghost"
                  size="xs"
                  placeholder="Link a workstream…"
                  emptyText="No workstreams."
                  [options]="relatedCandidates()"
                  (picked)="addRelated($event)"
                >
                  <svg [lucideIcon]="plusIcon" [size]="12"></svg>
                  <span class="text-muted-foreground text-xs">{{
                    d.relatedWorkstreamIds.length ? 'Add' : 'Link workstream'
                  }}</span>
                </app-entity-picker>
              }
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-muted-foreground text-xs font-medium">Tags</h3>
            <app-decision-tags
              [tags]="d.tags"
              [suggestions]="allTags()"
              [canEdit]="canEdit()"
              (tagsChange)="saveTags($event)"
            />
          </section>

          @if (supersedes().length || supersededBy() || (canEdit() && d.status === 'accepted')) {
            <section class="flex flex-col gap-2">
              <h3 class="text-muted-foreground text-xs font-medium">History</h3>
              @if (supersededBy(); as next) {
                <div class="flex flex-wrap items-center gap-1.5 text-xs">
                  <span class="text-muted-foreground">Replaced by</span>
                  <app-entity-chip type="decision" [ref]="next.id" />
                </div>
              }
              @for (old of supersedes(); track old.id) {
                <div class="flex flex-wrap items-center gap-1.5 text-xs">
                  <span class="text-muted-foreground">Replaces</span>
                  <app-entity-chip type="decision" [ref]="old.id" />
                </div>
              }
              @if (canEdit() && d.status === 'accepted' && others().length) {
                <app-entity-picker
                  variant="outline"
                  size="sm"
                  placeholder="Superseded by which decision?"
                  emptyText="No other decisions."
                  [options]="others()"
                  (picked)="supersede($event)"
                >
                  <svg [lucideIcon]="replaceIcon" [size]="13"></svg>
                  Supersede…
                </app-entity-picker>
              }
            </section>
          }

          <p class="text-meta">
            Created {{ d.createdAt | relativeTime }} · updated {{ d.updatedAt | relativeTime }}
          </p>
        </aside>
      </div>
    } @else {
      <app-empty-state
        [icon]="scale"
        title="Decision not found"
        description="It may have been deleted."
      >
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'decisions']"
          >Back to decisions</a
        >
      </app-empty-state>
    }
  `,
})
export class DecisionDetailPage {
  readonly workspaceSlug = input<string>();
  readonly key = input<string>();

  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);
  private readonly clipboard = inject(Clipboard);

  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly scale = LucideScale;
  protected readonly checkIcon = LucideCheck;
  protected readonly xIcon = LucideX;
  protected readonly plusIcon = LucidePlus;
  protected readonly replaceIcon = LucideReplace;
  protected readonly linkIcon = LucideLink2;
  protected readonly copyIcon = LucideCopy;

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly canDecide = computed(() => this.store.allowed('acceptDecisions'));
  protected readonly decision = computed(() => this.store.getDecision(this.key()));
  protected readonly statusLabel = computed(() => {
    const d = this.decision();
    return d ? DECISION_STATUS_META[d.status].label : '';
  });
  protected readonly statusHint = computed(() => STATUS_HINT[this.decision()?.status ?? ''] ?? '');
  protected readonly supersededBy = computed(() => {
    const id = this.decision()?.supersededById;
    return id ? this.store.decisionById().get(id) : undefined;
  });
  protected readonly supersedes = computed(() => {
    const id = this.decision()?.id;
    return id ? this.store.decisions().filter((d) => d.supersededById === id) : [];
  });
  protected readonly others = computed<EntityOption[]>(() => {
    const current = this.decision()?.id;
    return this.store
      .decisions()
      .filter((d) => d.id !== current && d.status !== 'rejected')
      .map((d) => ({
        value: d.id,
        label: d.key,
        hint: d.title,
        mono: true,
        status: d.status,
        statusEntity: 'other',
      }));
  });
  protected readonly originCandidates = computed<EntityOption[]>(() => {
    const current = this.decision()?.originWorkstreamId;
    return this.store
      .workstreams()
      .filter((w) => w.id !== current)
      .map((w) => ({
        value: w.id,
        label: w.key,
        hint: w.title,
        mono: true,
        status: w.status,
        statusEntity: 'workstream',
      }));
  });
  protected readonly relatedCandidates = computed<EntityOption[]>(() => {
    const d = this.decision();
    if (!d) return [];
    const taken = new Set(d.relatedWorkstreamIds);
    return this.store
      .workstreams()
      .filter((w) => !taken.has(w.id))
      .map((w) => ({
        value: w.id,
        label: w.key,
        hint: w.title,
        mono: true,
        status: w.status,
        statusEntity: 'workstream',
      }));
  });
  protected readonly allTags = computed(() => {
    const set = new Set<string>();
    for (const d of this.store.decisions()) for (const t of d.tags) set.add(t);
    return [...set].sort();
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Decisions', link: ['/', this.slug(), 'decisions'] },
    { label: this.decision()?.key ?? this.key() ?? '', mono: true },
  ]);

  protected saveTitle(title: string): void {
    const d = this.decision();
    if (d) void this.store.updateDecision(d.id, { title });
  }
  protected saveStatement(statement: string): void {
    const d = this.decision();
    if (d && statement.trim()) void this.store.updateDecision(d.id, { statement });
  }
  protected saveRationale(rationale: string): void {
    const d = this.decision();
    if (d) void this.store.updateDecision(d.id, { rationale: rationale.trim() || null });
  }
  protected saveTags(tags: string[]): void {
    const d = this.decision();
    if (d) void this.store.updateDecision(d.id, { tags });
  }
  protected setOrigin(id: string | null): void {
    const d = this.decision();
    if (!d) return;
    const next = id;
    if (next === (d.originWorkstreamId ?? null)) return;
    void this.store.updateDecision(d.id, { originWorkstreamId: next });
  }
  protected addRelated(id: string): void {
    const d = this.decision();
    if (d && !d.relatedWorkstreamIds.includes(id)) {
      void this.store.updateDecision(d.id, {
        relatedWorkstreamIds: [...d.relatedWorkstreamIds, id],
      });
    }
  }
  protected removeRelated(id: string): void {
    const d = this.decision();
    if (d)
      void this.store.updateDecision(d.id, {
        relatedWorkstreamIds: d.relatedWorkstreamIds.filter((x) => x !== id),
      });
  }
  protected async accept(): Promise<void> {
    const d = this.decision();
    if (d && (await this.store.acceptDecision(d.id)))
      this.notifier.success(`${d.key} accepted`, { description: d.title });
  }
  protected async proposeDraft(): Promise<void> {
    const d = this.decision();
    if (d?.statement.trim() && (await this.store.updateDecision(d.id, { status: 'proposed' })))
      this.notifier.success(`${d.key} proposed`, { description: d.title });
  }
  protected async reject(): Promise<void> {
    const d = this.decision();
    if (d && (await this.store.rejectDecision(d.id)))
      this.notifier.success(`${d.key} rejected`, { description: d.title });
  }
  protected async supersede(byId: string): Promise<void> {
    const d = this.decision();
    if (!d) return;
    const by = this.store.decisionById().get(byId);
    if (await this.store.supersedeDecision(d.id, byId)) {
      this.notifier.success(`${d.key} superseded`, {
        description: by ? `Replaced by ${by.key}` : undefined,
      });
    }
  }
  protected copyLink(): void {
    void this.clipboard.copy(location.href, 'Link copied');
  }
  protected copyKey(): void {
    const d = this.decision();
    if (d) void this.clipboard.copy(d.key, 'Key copied');
  }
  protected remove(): void {
    const d = this.decision();
    if (!d) return;
    this.ui.setConfirmDelete({
      title: `Delete ${d.key}?`,
      description: 'The decision and its comments are removed. This cannot be undone.',
      onConfirm: async () => {
        const ok = await this.store.deleteDecision(d.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'decisions']);
      },
    });
  }
}
