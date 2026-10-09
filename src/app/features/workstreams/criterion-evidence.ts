// Evidence line under an acceptance criterion: how many pieces of evidence back a `met` criterion (or "no evidence"),
// who declared it, and a "Link evidence" picker over the workstream's own artifacts plus a short note.
// Evidence is signalled, never required: a met criterion without it is flagged, not blocked.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideCheck, LucideDynamicIcon, LucidePaperclip } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, fullDate, type AcceptanceCriterion, type Workstream } from '../../core';
import { ArtifactIcon } from '../../shared/artifact';

/** Number of proofs a criterion has: artifacts that still belong to the workstream, plus the note. */
export function proofCount(c: AcceptanceCriterion, liveArtifactIds: ReadonlySet<string>): number {
  const linked = (c.evidence?.artifactIds ?? []).filter((id) => liveArtifactIds.has(id)).length;
  return linked + (c.evidence?.note?.trim() ? 1 : 0);
}

@Component({
  selector: 'app-criterion-evidence',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, HlmPopoverImports, HlmTooltip, LucideDynamicIcon, ArtifactIcon],
  host: { class: 'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs' },
  template: `
    @if (c().state === 'met') {
      <span
        class="rounded px-1.5 py-px"
        [class]="count() ? 'bg-muted text-muted-foreground' : 'bg-status-needs-input/15 text-status-needs-input'"
        [hlmTooltip]="who()"
        position="bottom"
        >{{ proofLabel() }}</span
      >
      @if (byAgent()) {
        <span class="text-muted-foreground" [hlmTooltip]="who()" position="bottom">declared by agent</span>
      }
    } @else if (count()) {
      <span class="text-muted-foreground">{{ proofLabel() }}</span>
    }
    @if (canEdit()) {
      <hlm-popover align="start" sideOffset="4" [state]="pop()" (stateChanged)="pop.set($event)">
        <button
          type="button"
          hlmPopoverTrigger
          class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded px-1 py-px underline-offset-2 hover:underline"
          (click)="reset()"
        >
          <svg [lucideIcon]="clip" [size]="12"></svg>Link evidence
        </button>
        <hlm-popover-content class="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3" *hlmPopoverPortal>
          <h3 class="text-sm font-medium">Evidence for this criterion</h3>
          @if (artifacts().length) {
            <ul class="flex max-h-56 flex-col overflow-y-auto">
              @for (a of artifacts(); track a.id) {
                <li>
                  <button
                    type="button"
                    class="hover:bg-hover flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px]"
                    role="checkbox"
                    [attr.aria-checked]="selected().has(a.id)"
                    (click)="toggle(a.id)"
                  >
                    <span class="flex size-4 shrink-0 items-center justify-center rounded border" [class.bg-primary]="selected().has(a.id)" [class.text-primary-foreground]="selected().has(a.id)">
                      @if (selected().has(a.id)) {
                        <svg [lucideIcon]="check" [size]="11"></svg>
                      }
                    </span>
                    <app-artifact-icon [kind]="a.kind" [state]="a.state" />
                    <span class="min-w-0 flex-1 truncate">{{ a.title }}</span>
                    @if (a.externalId) {
                      <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ a.externalId }}</span>
                    }
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="text-muted-foreground text-xs">This workstream has no artifacts yet: write a verification note.</p>
          }
          <input
            hlmInput
            class="h-8 text-xs"
            placeholder="Verification note (e.g. tested on staging)"
            aria-label="Verification note"
            maxlength="500"
            [value]="note()"
            (input)="draftNote.set($any($event.target).value)"
          />
          <p class="text-muted-foreground text-[11px]">Linking evidence does not change the criterion's state.</p>
          <div class="flex justify-end gap-2">
            <button hlmBtn size="sm" variant="ghost" (click)="pop.set('closed')">Cancel</button>
            <button hlmBtn size="sm" (click)="save()">Save</button>
          </div>
        </hlm-popover-content>
      </hlm-popover>
    }
  `,
})
export class CriterionEvidence {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  readonly c = input.required<AcceptanceCriterion>();

  protected readonly pop = signal<'open' | 'closed'>('closed');
  protected readonly clip = LucidePaperclip;
  protected readonly check = LucideCheck;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly artifacts = computed(() => this.store.artifactsByWorkstream().get(this.ws().id) ?? []);
  private readonly liveIds = computed(() => new Set(this.artifacts().map((a) => a.id)));
  protected readonly count = computed(() => proofCount(this.c(), this.liveIds()));
  protected readonly proofLabel = computed(() => {
    const n = this.count();
    return n === 0 ? 'no evidence' : n === 1 ? '1 piece of evidence' : `${n} pieces of evidence`;
  });
  protected readonly byAgent = computed(() => {
    const t = this.c().verifiedBy?.type;
    return t === 'agent';
  });
  /** "Verified by Ann · Oct 9, 2026" / "Declared by Claude (agent) · …" / no author for older criteria. */
  protected readonly who = computed(() => {
    const c = this.c();
    if (!c.verifiedBy) return 'Set before Trama recorded who verifies criteria';
    const name = this.store.actorName(c.verifiedBy);
    const verb = c.verifiedBy.type === 'user' ? 'Verified by' : 'Declared by';
    const kind = c.verifiedBy.type === 'agent' ? ' (agent)' : '';
    return `${verb} ${name}${kind}${c.verifiedAt ? ' · ' + fullDate(c.verifiedAt) : ''}`;
  });

  // Draft of the picker; `null` means "untouched", so it follows the stored evidence.
  private readonly draftIds = signal<Set<string> | null>(null);
  protected readonly draftNote = signal<string | null>(null);
  protected readonly selected = computed(
    () => this.draftIds() ?? new Set((this.c().evidence?.artifactIds ?? []).filter((id) => this.liveIds().has(id))),
  );
  protected readonly note = computed(() => this.draftNote() ?? this.c().evidence?.note ?? '');

  protected reset(): void {
    this.draftIds.set(null);
    this.draftNote.set(null);
  }
  protected toggle(id: string): void {
    const next = new Set(this.selected());
    if (!next.delete(id)) next.add(id);
    this.draftIds.set(next);
  }
  protected save(): void {
    const note = this.note().trim();
    const artifactIds = [...this.selected()];
    void this.store.updateCriterion(this.ws().id, this.c().id, {
      evidence: artifactIds.length || note ? { artifactIds, note: note || null } : null,
    });
    this.reset();
    this.pop.set('closed');
  }
}
