// "Transfer to workspace…": move a project, with its tasks, milestones and time entries, to another
// workspace the person administers. The dialog previews what maps where before anything changes.
// Mount `<app-project-transfer-dialog [project]="p" [(open)]="transferOpen" />` on the project page.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type { Project, ProjectTransferPreview } from '../../core/contracts/domain';
import { Notifier } from '../../core/notify/notifier';
import { SessionStore } from '../../core/session/session.store';
import { TramaStore } from '../../core/stores/trama.store';
import { AppSelect, type Option } from '../../shared/app-select';
import { V3DialogFoot, V3DialogHead, V3Field } from '../../shared/v3';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

@Component({
  selector: 'app-project-transfer-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, HlmButtonImports, AppSelect, V3DialogHead, V3DialogFoot, V3Field],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="close()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:max-w-[560px]"
        [showCloseButton]="false"
      >
        <v3-dialog-head kicker="PROJECT" (dismiss)="close()">
          <h2 hlmDialogTitle>Transfer to workspace…</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">
          Move this project, with its tasks, milestones and time entries, to another workspace.
        </p>

        <div class="flex flex-col gap-3.5 p-[18px]">
          <p class="text-muted-foreground text-[12.5px] leading-snug">
            {{ project().name }} leaves {{ store.workspace()?.name }}. Task keys such as
            <span class="font-mono">{{ project().key }}-1</span> stay as they are. You must be an owner or admin of both workspaces.
          </p>

          <v3-field label="TARGET WORKSPACE" for="transfer-target">
            <app-select
              controlId="transfer-target"
              label="Target workspace"
              [options]="targets()"
              [(value)]="target"
            />
          </v3-field>

          @if (error(); as e) {
            <p class="text-red font-mono text-[10.5px]" role="alert">{{ e }}</p>
          }

          @if (loading()) {
            <p class="text-faint font-mono text-[11px]">Checking what would move…</p>
          }

          @if (preview(); as pv) {
            <div class="border-border flex flex-col gap-3 border p-3">
              <div class="flex flex-col gap-1">
                <span class="text-faint font-mono text-[10px]">MOVES</span>
                <span class="text-[13px] tabular-nums">
                  {{ counts(pv) }}
                </span>
              </div>

              @if (pv.mappings.length) {
                <div class="flex flex-col gap-1">
                  <span class="text-faint font-mono text-[10px]">MAPPING</span>
                  <ul class="flex flex-col gap-1">
                    @for (m of pv.mappings; track m.kind + ':' + m.from) {
                      <li class="flex items-baseline gap-2 text-[12.5px]">
                        <span class="text-faint w-[52px] shrink-0 font-mono text-[10px] uppercase">{{ kindLabel(m.kind) }}</span>
                        <span class="min-w-0 truncate">{{ m.from }}</span>
                        <span class="text-faint" aria-hidden="true">→</span>
                        <span class="min-w-0 flex-1 truncate">{{ m.to }}</span>
                        @if (m.action === 'create') {
                          <span class="text-primary font-mono text-[10px]">new</span>
                        }
                        <span class="text-faint font-mono text-[11px] tabular-nums">{{ m.count }}</span>
                      </li>
                    }
                  </ul>
                </div>
              }

              @if (pv.guests.length) {
                <div class="flex flex-col gap-1">
                  <span class="text-faint font-mono text-[10px]">PEOPLE WHO KEEP ACCESS</span>
                  <ul class="flex flex-col gap-1">
                    @for (g of pv.guests; track g.userId) {
                      <li class="flex items-baseline gap-2 text-[12.5px]">
                        <span class="min-w-0 flex-1 truncate">{{ g.name }}</span>
                        <span class="text-faint font-mono text-[10px]">{{ guestLabel(g.action) }} · {{ g.role }}</span>
                      </li>
                    }
                  </ul>
                </div>
              }

              @if (pv.unassigned) {
                <p class="text-yellow font-mono text-[10.5px] leading-snug">
                  {{ plural(pv.unassigned, 'record') }} lose their assignee, lead or reporter: that person is not a member of
                  {{ pv.target.name }}.
                </p>
              }

              @for (b of pv.blockers; track b) {
                <p class="text-red font-mono text-[10.5px] leading-snug" role="alert">{{ b }}</p>
              }
            </div>
          }
        </div>

        <v3-dialog-foot hint="the project keeps its id and its link changes to the new workspace">
          <button hlmBtn type="button" variant="outline" (click)="close()">Cancel</button>
          <button hlmBtn type="button" [disabled]="!canTransfer()" (click)="transfer()">
            {{ busy() ? 'Transferring…' : 'Transfer project' }}
          </button>
        </v3-dialog-foot>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ProjectTransferDialog {
  protected readonly store = inject(TramaStore);
  private readonly session = inject(SessionStore);
  private readonly api = inject(ApiClient);
  private readonly notifier = inject(Notifier);
  private readonly router = inject(Router);

  readonly project = input.required<Project>();
  readonly open = model(false);

  protected readonly target = signal('');
  protected readonly preview = signal<ProjectTransferPreview | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly plural = plural;

  /** Every other workspace of the person. The server refuses the ones they do not administer. */
  protected readonly targets = computed<Option[]>(() => [
    { value: '', label: 'Choose a workspace…' },
    ...this.session
      .workspaces()
      .filter((w) => w.slug !== this.store.slug())
      .map((w) => ({
        value: w.slug,
        label: w.name,
        hint: w.personal ? `${w.slug} · personal` : w.slug,
      })),
  ]);

  protected readonly canTransfer = computed(() => {
    const pv = this.preview();
    return !!pv && pv.blockers.length === 0 && !this.busy() && !this.loading();
  });

  /** Guards against an answer for a target the person has already left. */
  private ticket = 0;

  constructor() {
    // A fresh start each time the dialog opens.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.target.set('');
        this.preview.set(null);
        this.error.set('');
        this.busy.set(false);
        this.loading.set(false);
      });
    });
    // Choosing a target asks the server what would happen.
    effect(() => {
      const slug = this.target();
      const source = this.store.slug();
      const id = untracked(() => this.project().id);
      untracked(() => void this.loadPreview(source, id, slug));
    });
  }

  protected close(): void {
    if (!this.busy()) this.open.set(false);
  }

  protected counts(pv: ProjectTransferPreview): string {
    return [
      plural(pv.counts.issues, 'task'),
      plural(pv.counts.milestones, 'milestone'),
      plural(pv.counts.timeEntries, 'time entry', 'time entries'),
    ].join(' · ');
  }

  protected kindLabel(kind: string): string {
    switch (kind) {
      case 'issue':
        return 'task';
      case 'project':
        return 'project';
      case 'project_health':
        return 'health';
      default:
        return kind;
    }
  }

  protected guestLabel(action: 'add' | 'extend' | 'keep'): string {
    switch (action) {
      case 'add':
        return 'added as guest';
      case 'extend':
        return 'guest access extended';
      default:
        return 'already a member';
    }
  }

  private async loadPreview(source: string | null, id: string, slug: string): Promise<void> {
    const ticket = ++this.ticket;
    this.preview.set(null);
    this.error.set('');
    if (!source || !slug) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    try {
      const pv = await this.api.projects.transferPreview(source, id, slug);
      if (ticket === this.ticket) this.preview.set(pv);
    } catch (e) {
      if (ticket === this.ticket) this.error.set(ApiError.from(e).message);
    } finally {
      if (ticket === this.ticket) this.loading.set(false);
    }
  }

  protected async transfer(): Promise<void> {
    const source = this.store.slug();
    const pv = this.preview();
    if (!source || !pv || !this.canTransfer()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.api.projects.transfer(source, this.project().id, pv.target.slug);
      this.notifier.success('Project transferred', { description: `Now in ${result.target.name}` });
      this.open.set(false);
      await this.router.navigate(['/', result.target.slug, 'projects', result.project.id]);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
