// Workstream overview (VISION §27): the outcome first (objective + acceptance criteria), then the
// demand it resolves (issues), open questions, dependencies, background and the Delta thread,
// with comments at the bottom and every property editable in the sidebar.
import { ProviderIcon } from '../../shared/provider-icon';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideArrowUpRight, LucideCopy, LucideDynamicIcon, LucideMessagesSquare, LucidePencil, LucideTarget } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { Clipboard, NablaStore, Notifier, isDeltaThreadUrl, type Workstream } from '../../core';
import { RelativeTimePipe } from '../../shared/pipes';
import { DemandSummary } from '../customers/demand-summary';
import type { RequestState } from '../customers/customer-model';
import { WsSideCards } from '../milestones/ws-side-cards';
import { WsProjectMilestones } from '../milestones/ws-project-milestones';
import { CommentThread } from './comments';
import { CriteriaList } from './criteria-list';
import { WsCompletionLine } from './ws-completion-line';
import { EditableMarkdown } from './inline-edit';
import { WsAttention } from './ws-attention';
import { WsDependencies } from './ws-dependencies';
import { WsInputRequests } from './ws-input-requests';
import { WsIssuesSection } from './ws-issues-section';
import { WsProperties } from './ws-properties';

@Component({
  selector: 'app-ws-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ProviderIcon,
    HlmButtonImports,
    HlmInputImports,
    HlmTooltip,
    LucideDynamicIcon,
    EditableMarkdown,
    CriteriaList,
    WsCompletionLine,
    CommentThread,
    WsAttention,
    WsDependencies,
    WsInputRequests,
    WsIssuesSection,
    DemandSummary,
    WsProjectMilestones,
    WsSideCards,
    WsProperties,
    RelativeTimePipe,
  ],
  host: { class: 'block' },
  template: `
    <div class="grid gap-x-8 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div class="flex min-w-0 flex-col gap-7">
        <app-ws-attention [ws]="ws()" />

        <section aria-labelledby="ws-objective-title" class="bg-card rounded-lg border border-border-strong px-4 pt-3 pb-2">
          <h2 id="ws-objective-title" class="text-entity-workstream mb-0.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
            <svg [lucideIcon]="target" [size]="13"></svg>Objective
            <span class="text-muted-foreground font-normal tracking-normal normal-case">· the outcome this workstream delivers</span>
          </h2>
          <app-editable-markdown
            class="text-[15px]"
            label="objective"
            placeholder="What must be true when this is done? Click to describe the outcome…"
            [value]="ws().objective"
            [canEdit]="canEdit()"
            (save)="store.updateWorkstream(ws().id, { objective: $event })"
          />
        </section>

        <section>
          <app-ws-completion-line [ws]="ws()" />
          <app-criteria-list [ws]="ws()" />
        </section>

        <app-ws-project-milestones [ws]="ws()" />

        <app-demand-summary [demand]="store.demand().get(ws().id)" [state]="demandState()" />

        <app-ws-issues-section [ws]="ws()" />

        <app-ws-input-requests [ws]="ws()" />

        <app-ws-dependencies [ws]="ws()" />

        <section>
          <h2 class="mb-1 text-sm font-semibold">Description</h2>
          <app-editable-markdown
            label="description"
            placeholder="Click to describe this workstream…"
            [value]="ws().description ?? ''"
            [canEdit]="canEdit()"
            (save)="store.updateWorkstream(ws().id, { description: $event || null })"
          />
        </section>

        <section>
          <h2 class="mb-1 text-sm font-semibold">Context <span class="text-muted-foreground font-normal">· why this exists</span></h2>
          <app-editable-markdown
            label="context"
            placeholder="Click to add the background: what prompted this, constraints, links…"
            [value]="ws().context ?? ''"
            [canEdit]="canEdit()"
            (save)="store.updateWorkstream(ws().id, { context: $event || null })"
          />
        </section>

        @if (store.deltaThreads()) {
        <section aria-labelledby="ws-delta-title">
          <h2 id="ws-delta-title" class="mb-2 text-sm font-semibold">Workspace</h2>
          <div class="bg-card flex flex-wrap items-center gap-3 rounded-lg border border-border-strong px-3 py-2.5">
            <span class="bg-accent text-foreground flex size-8 shrink-0 items-center justify-center rounded-md"><app-provider-icon provider="delta" [size]="18" /></span>
            @if (editingDelta()) {
              <input
                hlmInput
                class="h-8 min-w-0 flex-1 font-mono text-xs"
                aria-label="Delta thread URL"
                placeholder="https://delta.dev/t/…"
                [value]="deltaDraft()"
                [class.border-destructive]="deltaDraft().trim() && !deltaValid()"
                (input)="deltaDraft.set($any($event.target).value)"
                (keydown.enter)="saveDelta()"
                (keydown.escape)="editingDelta.set(false); $event.stopPropagation()"
              />
              <button hlmBtn size="sm" [disabled]="!deltaValid()" (click)="saveDelta()">Save</button>
              <button hlmBtn size="sm" variant="ghost" (click)="editingDelta.set(false)">Cancel</button>
            } @else {
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-medium">Delta thread</div>
                <div class="text-muted-foreground truncate font-mono text-xs">{{ ws().deltaThreadUrl }}</div>
              </div>
              <span class="flex items-center gap-1">
                <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" hlmTooltip="Copy URL" aria-label="Copy Delta thread URL" (click)="clipboard.copy(ws().deltaThreadUrl, 'Delta thread URL copied')">
                  <svg [lucideIcon]="copy" [size]="14"></svg>
                </button>
                @if (canEdit()) {
                  <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" hlmTooltip="Change thread" aria-label="Change Delta thread" (click)="startDelta()">
                    <svg [lucideIcon]="pencil" [size]="14"></svg>
                  </button>
                }
                <a hlmBtn size="sm" variant="outline" [href]="ws().deltaThreadUrl" target="_blank" rel="noopener noreferrer">
                  Open thread <svg [lucideIcon]="ext" [size]="13"></svg>
                </a>
              </span>
            }
          </div>
          @if (editingDelta() && deltaDraft().trim() && !deltaValid()) {
            <p class="text-destructive mt-1 text-xs">Use an https link on delta.dev.</p>
          }
        </section>
        }

        <section aria-labelledby="ws-comments-title">
          <h2 id="ws-comments-title" class="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <svg [lucideIcon]="comments" [size]="15" class="text-muted-foreground"></svg>Comments
          </h2>
          <app-comment-thread [subject]="{ type: 'workstream', id: ws().id }" />
        </section>
      </div>

      <aside class="lg:border-l lg:pl-6" aria-label="Properties">
        <div>
          <h2 class="text-muted-foreground mb-1 text-xs font-medium">Properties</h2>
          <app-ws-properties [ws]="ws()">
            <app-ws-side-cards [ws]="ws()" />
          </app-ws-properties>
          <div class="text-muted-foreground mt-4 flex flex-col gap-0.5 border-t pt-3 text-xs">
            <span>Created {{ ws().createdAt | relativeTime }} by {{ store.getUser(ws().createdById)?.name ?? 'someone' }}</span>
            <span>Updated {{ ws().updatedAt | relativeTime }}</span>
            @if (ws().shippedAt) {
              <span>Shipped {{ ws().shippedAt | relativeTime }}</span>
            }
          </div>
        </div>
      </aside>
    </div>
  `,
})
export class WsOverviewTab {
  protected readonly store = inject(NablaStore);
  protected readonly clipboard = inject(Clipboard);
  private readonly notify = inject(Notifier);
  readonly ws = input.required<Workstream>();

  protected readonly target = LucideTarget;
  protected readonly ext = LucideArrowUpRight;
  protected readonly copy = LucideCopy;
  protected readonly pencil = LucidePencil;
  protected readonly comments = LucideMessagesSquare;
  protected readonly canEdit = computed(() => this.store.can('member'));
  /** Customers wait on a workstream until it ships; canceled work delivers nothing. */
  protected readonly demandState = computed<RequestState>(() => {
    const status = this.ws().status;
    return status === 'shipped' ? 'delivered' : status === 'canceled' ? 'dropped' : 'open';
  });

  protected readonly editingDelta = signal(false);
  protected readonly deltaDraft = signal('');
  protected readonly deltaValid = computed(() => isDeltaThreadUrl(this.deltaDraft().trim()));

  protected startDelta(): void {
    this.deltaDraft.set(this.ws().deltaThreadUrl);
    this.editingDelta.set(true);
  }

  protected saveDelta(): void {
    const url = this.deltaDraft().trim();
    if (!isDeltaThreadUrl(url)) return;
    this.editingDelta.set(false);
    if (url !== this.ws().deltaThreadUrl) {
      void this.store.updateWorkstream(this.ws().id, { deltaThreadUrl: url });
      this.notify.success('Delta thread updated');
    }
  }
}
