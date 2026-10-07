import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideDynamicIcon, LucideGavel, LucidePlus, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { NablaStore, type Decision, type Workstream } from '../../core';
import { ActorLabel } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusBadge } from '../../shared/status';

@Component({
  selector: 'app-ws-decisions-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDialogImports,
    HlmInputImports,
    HlmLabelImports,
    HlmTextareaImports,
    LucideDynamicIcon,
    ActorLabel,
    EmptyState,
    KeyChip,
    RelativeTimePipe,
    StatusBadge,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex items-center gap-2 border-b px-4 py-2 sm:px-6">
      <span class="text-muted-foreground text-xs">{{ list().length }} decision{{ list().length === 1 ? '' : 's' }}</span>
      @if (canEdit()) {
        <button hlmBtn size="sm" class="ml-auto" (click)="open.set(true)"><svg [lucideIcon]="plus" [size]="14"></svg>Propose decision</button>
      }
    </div>

    @for (d of list(); track d.id) {
      <article class="hover:bg-muted/30 flex flex-col gap-1.5 border-b px-4 py-3 sm:px-6">
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <app-key-chip [value]="d.key" />
          <a [routerLink]="['/', slug(), 'decisions', d.key]" class="min-w-0 flex-1 text-sm font-medium hover:underline">{{ d.title }}</a>
          <app-status-badge [status]="d.status" />
        </div>
        <p class="text-muted-foreground line-clamp-2 text-sm">{{ d.statement }}</p>
        <div class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span class="inline-flex items-center gap-1.5">proposed by <app-actor [actor]="d.proposedBy" [size]="16" class="text-foreground" /></span>
          <span>{{ d.createdAt | relativeTime }}</span>
          <span>{{ d.originWorkstreamId === ws().id ? 'Originated here' : 'Related' }}</span>
          @for (t of d.tags; track t) {
            <span class="bg-muted rounded-md px-1.5 py-0.5">{{ t }}</span>
          }
          @if (d.status === 'proposed' && canEdit()) {
            <span class="ml-auto flex gap-1.5">
              <button hlmBtn size="sm" variant="outline" class="h-7 gap-1 text-xs" (click)="accept(d)"><svg [lucideIcon]="check" [size]="13"></svg>Accept</button>
              <button hlmBtn size="sm" variant="ghost" class="h-7 gap-1 text-xs" (click)="reject(d)"><svg [lucideIcon]="x" [size]="13"></svg>Reject</button>
            </span>
          }
        </div>
      </article>
    } @empty {
      <app-empty-state [icon]="gavel" title="No decisions yet" description="Record what the team decided and why, so people and agents can build on it.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="open.set(true)">Propose decision</button>
        }
      </app-empty-state>
    }

    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[92svh] overflow-y-auto sm:max-w-lg" (keydown.meta.enter)="propose()">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Propose decision</h2>
          <p hlmDialogDescription>It will be marked as proposed and shows up in {{ ws().key }}’s attention until accepted.</p>
        </hlm-dialog-header>
        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <label hlmLabel for="pd-title">Title</label>
            <input hlmInput id="pd-title" autocomplete="off" placeholder="Hash refresh tokens at rest" [value]="title()" (input)="title.set($any($event.target).value)" />
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="pd-statement">Statement</label>
            <textarea hlmTextarea id="pd-statement" rows="3" class="min-h-20" placeholder="What is decided?" [value]="statement()" (input)="statement.set($any($event.target).value)"></textarea>
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="pd-why">Rationale <span class="text-muted-foreground font-normal">(optional)</span></label>
            <textarea hlmTextarea id="pd-why" rows="3" class="min-h-20" placeholder="Why this and not the alternatives?" [value]="rationale()" (input)="rationale.set($any($event.target).value)"></textarea>
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="pd-tags">Tags <span class="text-muted-foreground font-normal">(comma separated)</span></label>
            <input hlmInput id="pd-tags" autocomplete="off" placeholder="security, api" [value]="tags()" (input)="tags.set($any($event.target).value)" />
          </div>
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="!title().trim() || !statement().trim() || busy()" (click)="propose()">Propose</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class WsDecisionsTab {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly title = signal('');
  protected readonly statement = signal('');
  protected readonly rationale = signal('');
  protected readonly tags = signal('');
  protected readonly plus = LucidePlus;
  protected readonly check = LucideCheck;
  protected readonly x = LucideX;
  protected readonly gavel = LucideGavel;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly list = computed(() =>
    [...(this.store.decisionsByWorkstream().get(this.ws().id) ?? [])].sort((a, b) =>
      a.status === 'proposed' && b.status !== 'proposed' ? -1 : b.status === 'proposed' && a.status !== 'proposed' ? 1 : b.number - a.number,
    ),
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.title.set('');
        this.statement.set('');
        this.rationale.set('');
        this.tags.set('');
        this.busy.set(false);
      });
    });
  }

  protected accept(d: Decision): void {
    void this.store.acceptDecision(d.id);
  }
  protected reject(d: Decision): void {
    void this.store.rejectDecision(d.id);
  }

  protected async propose(): Promise<void> {
    if (!this.title().trim() || !this.statement().trim() || this.busy()) return;
    this.busy.set(true);
    const d = await this.store.proposeDecision({
      title: this.title().trim(),
      statement: this.statement().trim(),
      rationale: this.rationale().trim() || undefined,
      tags: this.tags().split(',').map((t) => t.trim()).filter(Boolean),
      originWorkstreamId: this.ws().id,
    });
    this.busy.set(false);
    if (d) this.open.set(false);
  }
}
