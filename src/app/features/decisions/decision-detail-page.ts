import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideEllipsis, LucideScale, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { DECISION_STATUS_META, NablaStore, UiStore } from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorLabel } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { StatusBadge } from '../../shared/status';
import { CommentThread } from '../workstreams/comments';
import { EditableMarkdown, InlineText } from '../workstreams/inline-edit';
import { Picker, type PickOption } from '../workstreams/picker';

@Component({
  selector: 'app-decision-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TopBarActions,
    ActorLabel,
    EmptyState,
    KeyChip,
    RelativeTimePipe,
    PropertyRow,
    StatusBadge,
    CommentThread,
    InlineText,
    EditableMarkdown,
    Picker,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (decision(); as d) {
      <ng-template appTopBarActions>
        @if (canEdit() && d.status === 'proposed') {
          <button hlmBtn size="sm" (click)="accept()">Accept</button>
          <button hlmBtn size="sm" variant="outline" (click)="reject()">Reject</button>
        }
        @if (canEdit()) {
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="Decision actions">
            <svg [lucideIcon]="moreIcon" [size]="16"></svg>
          </button>
          <ng-template #more>
            <hlm-dropdown-menu class="w-44">
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete decision
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        }
      </ng-template>

      <header class="border-b px-4 pt-3 sm:px-6">
        <div class="flex min-w-0 items-center gap-2">
          <app-key-chip [value]="d.key" class="text-sm" />
          <app-status-badge [status]="d.status" />
          <app-inline-text
            class="min-w-0 flex-1"
            label="title"
            textClass="text-lg font-semibold tracking-tight"
            [value]="d.title"
            [canEdit]="canEdit()"
            (save)="saveTitle($event)"
          />
        </div>
        <p class="text-muted-foreground pb-3 text-xs">{{ statusLabel() }} · updated {{ d.updatedAt | relativeTime }}</p>
      </header>

      <div class="grid gap-x-8 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="flex min-w-0 flex-col gap-8">
          <section>
            <h2 class="mb-1 text-sm font-semibold">Decision</h2>
            <app-editable-markdown
              label="statement"
              placeholder="What was decided?"
              [value]="d.statement"
              [canEdit]="canEdit()"
              (save)="saveStatement($event)"
            />
          </section>
          <section>
            <h2 class="mb-1 text-sm font-semibold">Rationale</h2>
            <app-editable-markdown
              label="rationale"
              placeholder="Why this, and not the alternative?"
              [value]="d.rationale ?? ''"
              [canEdit]="canEdit()"
              (save)="saveRationale($event)"
            />
          </section>
          <section>
            <h2 class="mb-2 text-sm font-semibold">Comments</h2>
            <app-comment-thread [subject]="{ type: 'decision', id: d.id }" />
          </section>
        </div>

        <aside class="flex flex-col gap-1 lg:pt-1">
          <app-property-row label="Status"><app-status-badge [status]="d.status" /></app-property-row>
          <app-property-row label="Proposed by"><app-actor [actor]="d.proposedBy" [size]="18" /></app-property-row>
          @if (origin(); as w) {
            <app-property-row label="Origin">
              <a class="truncate text-sm hover:underline" [routerLink]="['/', slug(), 'workstreams', w.key]">{{ w.key }}</a>
            </app-property-row>
          }
          @if (supersededBy(); as next) {
            <app-property-row label="Replaced by">
              <a class="truncate font-mono text-xs hover:underline" [routerLink]="['/', slug(), 'decisions', next.key]">{{ next.key }}</a>
            </app-property-row>
          }
          <app-property-row label="Tags">
            <span class="truncate text-sm">{{ d.tags.length ? d.tags.join(', ') : 'None' }}</span>
          </app-property-row>
          @if (canEdit() && d.status === 'accepted' && others().length) {
            <app-property-row label="Supersede">
              <app-picker
                variant="field"
                label="Supersede with"
                placeholder="Choose a decision"
                [options]="others()"
                [value]="supersedePick()"
                (valueChange)="supersede($event)"
              />
            </app-property-row>
          }
        </aside>
      </div>
    } @else {
      <app-empty-state [icon]="scale" title="Decision not found" description="It may have been deleted.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'decisions']">Back to decisions</a>
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

  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly scale = LucideScale;
  protected readonly supersedePick = signal<string[]>([]);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly decision = computed(() => this.store.getDecision(this.key()));
  protected readonly statusLabel = computed(() => {
    const d = this.decision();
    return d ? DECISION_STATUS_META[d.status].label : '';
  });
  protected readonly origin = computed(() => {
    const id = this.decision()?.originWorkstreamId;
    return id ? this.store.workstreamById().get(id) : undefined;
  });
  protected readonly supersededBy = computed(() => {
    const id = this.decision()?.supersededById;
    return id ? this.store.decisionById().get(id) : undefined;
  });
  protected readonly others = computed<PickOption[]>(() => {
    const current = this.decision()?.id;
    return this.store
      .decisions()
      .filter((d) => d.id !== current)
      .map((d) => ({ value: d.id, label: d.title, hint: d.key }));
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
  protected accept(): void {
    const d = this.decision();
    if (d) void this.store.acceptDecision(d.id);
  }
  protected reject(): void {
    const d = this.decision();
    if (d) void this.store.rejectDecision(d.id);
  }
  protected supersede(ids: string[]): void {
    const d = this.decision();
    const byId = ids[0];
    this.supersedePick.set([]);
    if (d && byId) void this.store.supersedeDecision(d.id, byId);
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
