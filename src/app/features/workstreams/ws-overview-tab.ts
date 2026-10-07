import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBellRing, LucideDynamicIcon } from '@lucide/angular';
import { ATTENTION_KIND_META, INTAKE_STATE_META, NablaStore, type AttentionItem, type Workstream } from '../../core';
import { IntakeKindLabel } from '../../shared/intake';
import { KeyChip } from '../../shared/key-chip';
import { RelativeTimePipe } from '../../shared/pipes';
import { CriteriaList } from './criteria-list';
import { EditableMarkdown } from './inline-edit';
import { WsProperties } from './ws-properties';

@Component({
  selector: 'app-ws-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    EditableMarkdown,
    CriteriaList,
    WsProperties,
    IntakeKindLabel,
    KeyChip,
    RelativeTimePipe,
  ],
  host: { class: 'block' },
  template: `
    <div class="grid gap-x-8 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div class="flex min-w-0 flex-col gap-6">
        @if (attention().length) {
          <section aria-label="Needs attention">
            <h2 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <svg [lucideIcon]="bell" [size]="14" class="text-status-needs-input"></svg>Needs attention
            </h2>
            <ul class="flex flex-col overflow-hidden rounded-lg border">
              @for (a of attention(); track a.id) {
                <li class="flex items-start gap-2.5 border-b px-3 py-2 text-sm last:border-b-0">
                  <span class="mt-1.5 size-2 shrink-0 rounded-full" [class]="dot(a)"></span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-baseline gap-x-2">
                      <span class="font-medium">{{ a.title }}</span>
                      <span class="text-muted-foreground text-xs">{{ kindLabel(a) }} · {{ a.since | relativeTime }}</span>
                    </div>
                    <p class="text-muted-foreground text-xs">{{ a.detail }}</p>
                  </div>
                  @if (a.executionId) {
                    <a class="text-primary shrink-0 text-xs hover:underline" [routerLink]="['/', slug(), 'executions', a.executionId]">Open</a>
                  }
                </li>
              }
            </ul>
          </section>
        }

        <section>
          <h2 class="mb-1 text-sm font-semibold">Objective</h2>
          <app-editable-markdown
            label="objective"
            placeholder="Click to describe the outcome this workstream should achieve…"
            [value]="ws().objective"
            [canEdit]="canEdit()"
            (save)="store.updateWorkstream(ws().id, { objective: $event })"
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

        <section>
          <app-criteria-list [ws]="ws()" />
        </section>

        <section>
          <h2 class="mb-2 text-sm font-semibold">Linked intake</h2>
          @if (intake().length) {
            <ul class="flex flex-col overflow-hidden rounded-lg border">
              @for (i of intake(); track i.id) {
                <li>
                  <a [routerLink]="['/', slug(), 'intake', i.key]" class="hover:bg-muted/50 flex min-h-9 items-center gap-2.5 border-b px-3 text-sm last:border-b-0">
                    <app-intake-kind [kind]="i.kind" />
                    <app-key-chip [value]="i.key" class="w-16" />
                    <span class="min-w-0 flex-1 truncate">{{ i.title }}</span>
                    <span class="text-muted-foreground text-xs max-sm:hidden">{{ stateLabel(i.state) }}</span>
                  </a>
                </li>
              }
            </ul>
          } @else {
            <p class="text-muted-foreground text-sm">No intake items are linked. Triage an item into this workstream from the Intake queue.</p>
          }
        </section>
      </div>

      <aside class="lg:border-l lg:pl-6" aria-label="Properties">
        <h2 class="mb-1 text-sm font-semibold">Properties</h2>
        <app-ws-properties [ws]="ws()" />
        <div class="text-muted-foreground mt-4 flex flex-col gap-0.5 border-t pt-3 text-xs">
          <span>Created {{ ws().createdAt | relativeTime }} by {{ store.getUser(ws().createdById)?.name ?? 'someone' }}</span>
          <span>Updated {{ ws().updatedAt | relativeTime }}</span>
          @if (ws().shippedAt) {
            <span>Shipped {{ ws().shippedAt | relativeTime }}</span>
          }
        </div>
      </aside>
    </div>
  `,
})
export class WsOverviewTab {
  protected readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  protected readonly bell = LucideBellRing;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly attention = computed(() => this.store.openAttention().filter((a) => a.workstreamId === this.ws().id));
  protected readonly intake = computed(() => this.store.intakeByWorkstream().get(this.ws().id) ?? []);

  protected kindLabel(a: AttentionItem): string {
    return ATTENTION_KIND_META[a.kind].label;
  }
  protected stateLabel(s: keyof typeof INTAKE_STATE_META): string {
    return INTAKE_STATE_META[s].label;
  }
  protected dot(a: AttentionItem): string {
    return a.severity === 'high' ? 'bg-status-blocked' : a.severity === 'medium' ? 'bg-status-needs-input' : 'bg-status-draft';
  }
}
