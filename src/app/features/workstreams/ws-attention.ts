// "Needs attention" on a workstream, made actionable: answer input requests inline, accept /
// reject proposed decisions, open the PR behind CI / review / conflict items, open triage issues,
// and snooze or dismiss anything.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAlarmClock, LucideArrowUpRight, LucideBellRing, LucideDynamicIcon, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ATTENTION_KIND_META, NablaStore, type AttentionItem, type Workstream } from '../../core';
import { RelativeTimePipe } from '../../shared/pipes';
import { InputRequestItem } from './ws-input-requests';

@Component({
  selector: 'app-ws-attention',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmTooltip, LucideDynamicIcon, RelativeTimePipe, InputRequestItem],
  host: { class: 'block' },
  template: `
    @if (items().length) {
      <section aria-labelledby="ws-attn-title" class="border-status-needs-input/30 bg-status-needs-input/[0.04] overflow-hidden rounded-lg border">
        <h2 id="ws-attn-title" class="flex h-9 items-center gap-1.5 border-b border-inherit px-3 text-[13px] font-semibold">
          <svg [lucideIcon]="bell" [size]="14" class="text-status-needs-input"></svg>Needs attention
          <span class="text-muted-foreground font-normal tabular-nums">{{ items().length }}</span>
        </h2>
        <ul class="flex flex-col">
          @for (a of items(); track a.id) {
            <li class="group/attn flex items-start gap-2.5 border-b border-inherit px-3 py-2.5 text-[13px] last:border-b-0">
              <span class="mt-1.5 size-2 shrink-0 rounded-full" [class]="dot(a)" [hlmTooltip]="a.severity + ' severity'"></span>
              <div class="min-w-0 flex-1">
                @if (request(a); as r) {
                  <app-input-request-item [request]="r" [compact]="true" />
                } @else {
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    <span class="font-medium">{{ a.title }}</span>
                    <span class="text-muted-foreground text-xs">{{ kindLabel(a) }} · {{ a.since | relativeTime }}</span>
                  </div>
                  @if (a.detail) {
                    <p class="text-muted-foreground text-xs">{{ a.detail }}</p>
                  }
                  <div class="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
                    @if (a.kind === 'needs_decision' && a.decisionId && canDecide()) {
                      <button hlmBtn size="xs" (click)="store.acceptDecision(a.decisionId!)">Accept</button>
                      <button hlmBtn size="xs" variant="outline" (click)="store.rejectDecision(a.decisionId!)">Reject</button>
                    }
                    @if (decisionKey(a); as key) {
                      <a hlmBtn size="xs" variant="ghost" [routerLink]="['/', slug(), 'decisions', key]">Open {{ key }}</a>
                    }
                    @if (artifactUrl(a); as url) {
                      <a hlmBtn size="xs" variant="outline" [href]="url" target="_blank" rel="noopener noreferrer">
                        Open {{ artifactLabel(a) }}<svg [lucideIcon]="ext" [size]="12"></svg>
                      </a>
                    }
                    @if (issueKey(a); as key) {
                      <a hlmBtn size="xs" variant="outline" [routerLink]="['/', slug(), 'issues', key]">Open {{ key }}</a>
                    }
                  </div>
                }
              </div>
              <span class="flex shrink-0 items-center opacity-60 group-hover/attn:opacity-100">
                <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground" hlmTooltip="Snooze until tomorrow" aria-label="Snooze until tomorrow" (click)="snooze(a)">
                  <svg [lucideIcon]="clock" [size]="13"></svg>
                </button>
                <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground" hlmTooltip="Dismiss" aria-label="Dismiss" (click)="store.dismissAttention(a.id)">
                  <svg [lucideIcon]="xIcon" [size]="13"></svg>
                </button>
              </span>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class WsAttention {
  protected readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();

  protected readonly bell = LucideBellRing;
  protected readonly ext = LucideArrowUpRight;
  protected readonly clock = LucideAlarmClock;
  protected readonly xIcon = LucideX;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canDecide = computed(() => this.store.allowed('acceptDecisions'));
  protected readonly items = computed(() => this.store.openAttention().filter((a) => a.workstreamId === this.ws().id));

  protected request(a: AttentionItem) {
    if (a.kind !== 'input_requested' || !a.inputRequestId) return undefined;
    const r = this.store.inputRequestById().get(a.inputRequestId);
    return r?.state === 'open' ? r : undefined;
  }
  protected kindLabel(a: AttentionItem): string {
    return ATTENTION_KIND_META[a.kind].label;
  }
  protected decisionKey(a: AttentionItem): string | undefined {
    return a.decisionId ? this.store.getDecision(a.decisionId)?.key : undefined;
  }
  protected issueKey(a: AttentionItem): string | undefined {
    return a.issueId ? this.store.getIssue(a.issueId)?.key : undefined;
  }
  protected artifactUrl(a: AttentionItem): string | undefined {
    return a.artifactId ? this.store.getArtifact(a.artifactId)?.url : undefined;
  }
  protected artifactLabel(a: AttentionItem): string {
    const art = a.artifactId ? this.store.getArtifact(a.artifactId) : undefined;
    return art?.externalId ?? 'artifact';
  }
  protected snooze(a: AttentionItem): void {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    void this.store.snoozeAttention(a.id, d.toISOString());
  }
  protected dot(a: AttentionItem): string {
    return a.severity === 'high' ? 'bg-status-blocked' : a.severity === 'medium' ? 'bg-status-needs-input' : 'bg-status-draft';
  }
}
