// The plan of a workstream, when it has one: "Plan: <title> · rev v3 · approved by Ann". A plan is a `document`
// artifact whose title starts with "Plan", and its approval is an ordinary decision that cites the revision (see
// `resolveWorkstreamPlans`). Nothing is shown for a workstream without a plan; nothing here blocks work.
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideScrollText } from '@lucide/angular';
import { TramaStore, isPlanArtifact, resolveWorkstreamPlans, type ID, type Workstream } from '../../core';
import { Documents } from '../documents/documents.service';

@Component({
  selector: 'app-ws-plan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    @for (r of rows(); track r.plan.artifactId) {
      <p class="text-muted-foreground mb-2 flex flex-wrap items-center gap-x-1.5 text-[13px] leading-snug" data-testid="plan-line">
        <svg [lucideIcon]="icon" [size]="14" class="shrink-0"></svg>
        <span>Plan:</span>
        @if (r.plan.documentId) {
          <a [routerLink]="['/', slug(), 'documents', r.plan.documentId]" class="text-foreground font-medium hover:underline">{{ r.plan.title }}</a>
        } @else if (r.plan.url) {
          <a [href]="r.plan.url" target="_blank" rel="noopener noreferrer" class="text-foreground font-medium hover:underline">{{ r.plan.title }}</a>
        } @else {
          <span class="text-foreground font-medium">{{ r.plan.title }}</span>
        }
        @if (r.plan.revision) {
          <span aria-hidden="true">·</span>
          <span class="font-mono text-xs">rev {{ r.plan.revision }}</span>
        }
        <span aria-hidden="true">·</span>
        @if (r.plan.changedSinceApproval) {
          <span class="text-status-needs-input font-medium">changed since approval</span>
          @if (r.plan.approved; as a) {
            <span>(approved {{ a.revision }} in <a [routerLink]="['/', slug(), 'decisions', a.decisionKey]" class="hover:underline">{{ a.decisionKey }}</a>)</span>
          }
        } @else if (r.plan.approved; as a) {
          <span class="text-status-shipped font-medium">approved{{ r.by ? ' by ' + r.by : '' }}</span>
          <a [routerLink]="['/', slug(), 'decisions', a.decisionKey]" class="font-mono text-xs hover:underline">{{ a.decisionKey }}</a>
        } @else {
          <span class="text-foreground font-medium">not approved</span>
        }
        @if (r.plan.proposedDecisionKey; as k) {
          <span>· <a [routerLink]="['/', slug(), 'decisions', k]" class="font-mono text-xs hover:underline">{{ k }}</a> awaits a person</span>
        }
      </p>
    }
  `,
})
export class WsPlan {
  private readonly store = inject(TramaStore);
  private readonly documents = inject(Documents);
  readonly ws = input.required<Workstream>();

  protected readonly icon = LucideScrollText;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  /** Current `version` of each Trama document plan; a plan is shown once its version is known. */
  private readonly versions = signal<ReadonlyMap<ID, number>>(new Map());
  private loads = 0;

  private readonly artifacts = computed(() => this.store.artifactsByWorkstream().get(this.ws().id) ?? []);
  private readonly documentIds = computed(() =>
    this.artifacts().flatMap((a) => (isPlanArtifact(a) && a.documentId ? [a.documentId] : [])),
  );

  protected readonly rows = computed(() => {
    const versions = this.versions();
    const decisions = this.store.decisionsByWorkstream().get(this.ws().id) ?? [];
    return resolveWorkstreamPlans({
      workstreamId: this.ws().id,
      artifacts: this.artifacts(),
      decisions,
      documentVersions: versions,
    })
      .filter((p) => !p.documentId || versions.has(p.documentId))
      .map((plan) => {
        const d = plan.approved ? decisions.find((x) => x.key === plan.approved?.decisionKey) : undefined;
        return { plan, by: this.store.getUser(d?.decidedById)?.name ?? '' };
      });
  });

  constructor() {
    effect(() => {
      const ids = this.documentIds();
      this.documents.changes();
      untracked(() => void this.load(ids));
    });
  }

  private async load(ids: ID[]): Promise<void> {
    const run = ++this.loads;
    const out = new Map<ID, number>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          out.set(id, (await this.documents.get(id)).version);
        } catch {
          // A document that cannot be read (deleted, no access) is simply not shown as a plan.
        }
      }),
    );
    if (run === this.loads) this.versions.set(out);
  }
}
