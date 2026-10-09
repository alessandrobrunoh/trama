import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { ApiError, TramaStore, type DocumentRevision } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { RelativeTimePipe } from '../../shared/pipes';
import { Documents } from './documents.service';
import { diffStats, lineDiff, type DiffOp } from './text-merge';

/** Lines of unchanged context kept around each change. */
const CONTEXT = 2;
const MAX_ROWS = 600;

interface Row {
  kind: DiffOp['t'] | 'gap';
  text: string;
}

/** Changed lines with a little context, unchanged stretches collapsed to a gap. */
function compact(ops: readonly DiffOp[]): { rows: Row[]; truncated: boolean } {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === 'eq') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++)
      keep[k] = true;
  });
  const rows: Row[] = [];
  let gap = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (gap) rows.push({ kind: 'gap', text: `${gap} unchanged line${gap === 1 ? '' : 's'}` });
      gap = 0;
      rows.push({ kind: o.t, text: o.line });
    } else gap++;
  });
  if (gap) rows.push({ kind: 'gap', text: `${gap} unchanged line${gap === 1 ? '' : 's'}` });
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

/**
 * Revision history of a document: pick a version to see what changed against the text on screen, and bring it
 * back as a new version (history is never rewritten).
 */
@Component({
  selector: 'app-document-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDialogImports, ActorAvatar, RelativeTimePipe],
  host: { class: 'contents' },
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="flex max-h-[88svh] flex-col gap-3 sm:max-w-3xl"
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Version history</h2>
          <p hlmDialogDescription>
            Pick a version to compare it with the text on screen. Restoring adds a new version;
            nothing is lost.
          </p>
        </hlm-dialog-header>

        <div class="grid min-h-0 flex-1 gap-3 sm:grid-cols-[14rem_1fr]">
          <ol
            class="max-h-40 overflow-y-auto rounded-md border sm:max-h-[60svh]"
            aria-label="Versions"
          >
            @for (r of revisions(); track r.id; let first = $first) {
              <li>
                <button
                  type="button"
                  class="hover:bg-accent flex w-full items-center gap-2 border-b px-2.5 py-2 text-left text-xs last:border-b-0"
                  [class.bg-accent]="r.version === selected()"
                  [attr.aria-current]="r.version === selected() ? 'true' : null"
                  (click)="select(r.version)"
                >
                  <app-actor-avatar [actor]="r.editor" [size]="18" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-medium">{{ store.actorName(r.editor) }}</span>
                    <span class="text-muted-foreground block"
                      >{{ r.createdAt | relativeTime }} · v{{ r.version }}</span
                    >
                  </span>
                  @if (first) {
                    <span class="text-muted-foreground text-[11px]">latest</span>
                  }
                </button>
              </li>
            } @empty {
              <li class="text-muted-foreground px-3 py-6 text-center text-xs">
                {{ loading() ? 'Loading…' : 'No versions yet.' }}
              </li>
            }
          </ol>

          <div class="flex min-h-0 min-w-0 flex-col rounded-md border">
            @if (loadingRevision()) {
              <p class="text-muted-foreground p-6 text-center text-xs">Loading…</p>
            } @else if (revision(); as rev) {
              <div class="flex items-center gap-2 border-b px-3 py-2 text-xs">
                <span class="font-medium">v{{ rev.version }} · {{ rev.title }}</span>
                <span class="text-muted-foreground ml-auto tabular-nums">
                  <span class="text-status-shipped">+{{ stats().added }}</span>
                  <span class="text-status-blocked ml-1.5">−{{ stats().removed }}</span>
                  compared with now
                </span>
              </div>
              <div
                class="max-h-[50svh] min-h-0 flex-1 overflow-auto font-mono text-xs leading-5 sm:max-h-[52svh]"
                role="region"
                aria-label="Changes"
              >
                @for (row of diff().rows; track $index) {
                  @switch (row.kind) {
                    @case ('gap') {
                      <div class="text-muted-foreground bg-muted/40 px-3 py-0.5 text-[11px]">
                        … {{ row.text }}
                      </div>
                    }
                    @case ('add') {
                      <div class="bg-status-shipped/10 px-3 whitespace-pre-wrap break-words">
                        <span class="text-status-shipped select-none">+ </span>{{ row.text }}
                      </div>
                    }
                    @case ('del') {
                      <div class="bg-status-blocked/10 px-3 whitespace-pre-wrap break-words">
                        <span class="text-status-blocked select-none">− </span>{{ row.text }}
                      </div>
                    }
                    @default {
                      <div class="text-muted-foreground px-3 whitespace-pre-wrap break-words">
                        &nbsp;&nbsp;{{ row.text }}
                      </div>
                    }
                  }
                } @empty {
                  <p class="text-muted-foreground p-6 text-center text-xs">
                    This version is the same as the text on screen.
                  </p>
                }
                @if (diff().truncated) {
                  <p class="text-muted-foreground px-3 py-2 text-[11px]">
                    Showing the first {{ maxRows }} lines of the difference.
                  </p>
                }
              </div>
            } @else {
              <p class="text-muted-foreground p-6 text-center text-xs">Select a version.</p>
            }
          </div>
        </div>

        @if (error()) {
          <p class="text-destructive text-xs" role="alert">{{ error() }}</p>
        }
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Close</button>
          <button hlmBtn type="button" [disabled]="!canRestore()" (click)="restore()">
            Restore this version
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class DocumentHistory {
  protected readonly store = inject(TramaStore);
  private readonly documents = inject(Documents);

  readonly open = model(false);
  readonly documentId = input.required<string>();
  /** The text on screen (unsaved edits included): what versions are compared with. */
  readonly currentBody = input.required<string>();
  readonly currentTitle = input.required<string>();
  readonly canEdit = input(true);
  /** Asked to bring this version back; the page saves first and restores. Resolves when done. */
  readonly restoreRequested = output<{ version: number; done: (ok: string | null) => void }>();

  protected readonly maxRows = MAX_ROWS;
  protected readonly revisions = signal<DocumentRevision[]>([]);
  protected readonly selected = signal<number | null>(null);
  protected readonly revision = signal<DocumentRevision | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadingRevision = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly ops = computed(() => {
    const rev = this.revision();
    // from the old version to now: added lines are what the document gained since
    return rev ? lineDiff((rev.body ?? '').split('\n'), this.currentBody().split('\n')) : [];
  });
  protected readonly diff = computed(() => compact(this.ops()));
  protected readonly stats = computed(() => diffStats(this.ops()));
  protected readonly canRestore = computed(() => {
    const rev = this.revision();
    return (
      this.canEdit() &&
      !this.busy() &&
      !!rev &&
      (rev.body !== this.currentBody() || rev.title !== this.currentTitle())
    );
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const id = this.documentId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.revision.set(null);
    this.selected.set(null);
    try {
      const rows = await this.documents.revisions(id);
      this.revisions.set(rows);
      if (rows.length) await this.select(rows[0].version);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Could not load the history');
    } finally {
      this.loading.set(false);
    }
  }

  protected async select(version: number): Promise<void> {
    this.selected.set(version);
    this.loadingRevision.set(true);
    try {
      const rev = await this.documents.revision(this.documentId(), version);
      if (this.selected() === version) this.revision.set(rev);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Could not load that version');
    } finally {
      this.loadingRevision.set(false);
    }
  }

  protected restore(): void {
    const rev = this.revision();
    if (!rev) return;
    this.busy.set(true);
    this.error.set(null);
    this.restoreRequested.emit({
      version: rev.version,
      done: (err) => {
        this.busy.set(false);
        if (err) this.error.set(err);
        else this.open.set(false);
      },
    });
  }
}
