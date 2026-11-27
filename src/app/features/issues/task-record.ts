// The Delta thread record of the task page (v3 "06 Task detail" / "07 Subtask detail", DESIGN.md §6): a read-only
// panel for the thread linked to the task, or the empty state when there is none. Trama holds the link, the pull
// requests and the task's own events, plus the record the agent keeps with `trama sync` (summary, decisions,
// changed files, turns), so the panel shows: head (thread id, who linked it, when it last synced, open / copy),
// the summary, decisions, key events, changed files and the pull requests.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { format } from 'date-fns';
import {
  LucideDynamicIcon,
  LucideFileText,
  LucideGitMerge,
  LucideGitPullRequest,
} from '@lucide/angular';
import { HlmButton } from '@spartan-ng/helm/button';
import {
  ApiClient,
  ApiError,
  Clipboard,
  TramaStore,
  type Artifact,
  type Issue,
  type ThreadRecord,
} from '../../core';
import { AgoPipe } from '../../shared/ago';
import { Kbd } from '../../shared/kbd';
import { buildStream } from './issue-stream-model';
import {
  artifactLine,
  isRequest,
  linkedBy,
  recordEvents,
  recordFiles,
  recordSize,
  sortArtifacts,
  syncedText,
  threadId,
} from './task-record-model';
import { TaskSectionHead } from './task-section-head';

const REPORT_MAX = 420;

@Component({
  selector: 'app-task-record',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, Kbd, LucideDynamicIcon, AgoPipe, TaskSectionHead],
  host: { class: 'flex w-full min-w-0 flex-col gap-3' },
  template: `
    @let i = issue();
    <app-task-section-head title="Delta thread" [caption]="caption()">
      @if (linked(); as who) {
        <span class="text-faint font-mono text-[10.5px] leading-[14px] whitespace-nowrap">{{ who }}</span>
      }
    </app-task-section-head>

    @if (i.threadUrl; as url) {
      <article class="bg-card border-border flex flex-col border" aria-label="Delta thread record">
        <div class="border-border flex flex-col gap-2.5 border-b px-[18px] py-4">
          <div class="flex items-center gap-2">
            <span class="bg-delta-line size-2 shrink-0" aria-hidden="true"></span>
            <span class="text-delta font-mono text-[10.5px] leading-[14px]">DELTA THREAD</span>
            <span class="flex-1"></span>
            <span class="text-faint font-mono text-[10.5px] leading-[14px]">{{ sync() ? 'read-only · ' + sync() : 'read-only' }}</span>
          </div>
          <h3 class="font-title text-foreground text-[22px] leading-[22px] tracking-normal! break-words">{{ i.title }}</h3>
          <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] leading-[14px]">
            <span class="text-muted-foreground">{{ id() }}</span>
            @if (by(); as name) {
              <span class="text-faint">by {{ name }}</span>
            }
            <span class="text-faint">{{ host() }}</span>
            @if (size(); as s) {
              <span class="text-faint">{{ s }}</span>
            }
          </div>
          <div class="flex flex-wrap items-start gap-2">
            <a hlmBtn variant="outline" [href]="url" target="_blank" rel="noopener noreferrer"
              >Open in Delta ↗ <app-kbd keys="o"
            /></a>
            <button hlmBtn variant="outline" type="button" (click)="copyLink(url)">
              Copy share link <app-kbd keys="shift+l" />
            </button>
          </div>
        </div>

        @if (report(); as r) {
          <div class="border-border flex flex-col gap-2 border-b px-[18px] py-3.5">
            <div class="flex items-baseline gap-2">
              <span class="text-faint font-mono text-[10px] leading-[13px]">SUMMARY</span>
            </div>
            <p class="text-text-2 text-[13.5px] leading-[21px] break-words whitespace-pre-line">{{ r.text }}</p>
          </div>
        }

        @if (decisions().length) {
          <div class="border-border flex flex-col gap-[7px] border-b px-[18px] py-3.5">
            <span class="text-faint font-mono text-[10px] leading-[13px]">DECISIONS</span>
            @for (d of decisions(); track d.id) {
              <div class="flex items-start gap-2">
                <span class="text-delta-line font-mono text-[11px] leading-[19px]" aria-hidden="true">→</span>
                <span class="text-text-2 min-w-0 flex-1 text-[13px] leading-[19px] break-words">{{ d.text }}</span>
              </div>
            }
          </div>
        }

        @if (events().length) {
          <div class="border-border flex flex-col gap-[7px] border-b px-[18px] py-3.5">
            <span class="text-faint font-mono text-[10px] leading-[13px]">KEY EVENTS</span>
            @for (e of events(); track e.id) {
              <div class="flex items-baseline gap-3">
                <span class="text-faint w-24 shrink-0 font-mono text-[10.5px] leading-[14px]">{{ when(e.at) }}</span>
                <span class="text-text-2 min-w-0 text-[13px] leading-[17px] break-words">{{ e.text }}</span>
              </div>
            }
          </div>
        }

        @if (files().shown.length) {
          <div class="border-border flex flex-col gap-1.5 border-b px-[18px] py-3.5">
            <span class="text-faint font-mono text-[10px] leading-[13px]">CHANGES VS ORIGIN/MAIN</span>
            @for (f of files().shown; track f) {
              <span class="text-text-2 min-w-0 font-mono text-[11px] leading-[14px] break-all">{{ f }}</span>
            }
            @if (files().more; as more) {
              <span class="text-faint font-mono text-[11px] leading-[14px]">{{ more }} more file{{ more === 1 ? '' : 's' }}</span>
            }
          </div>
        }

        <div class="flex flex-col gap-1.5 px-[18px] py-3.5">
          <span class="text-faint font-mono text-[10px] leading-[13px]">{{ requests().length ? 'PULL REQUESTS' : 'ARTIFACTS' }}</span>
          @for (a of artifacts(); track a.id) {
            <div class="flex items-center gap-2 py-px">
              <svg
                [lucideIcon]="iconOf(a)"
                [size]="13"
                class="shrink-0"
                [class]="a.state === 'merged' ? 'text-delta' : a.state === 'closed' ? 'text-faint' : 'text-green'"
                aria-hidden="true"
              ></svg>
              @if (a.url; as href) {
                <a
                  [href]="href"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-foreground min-w-0 truncate font-mono text-[11px] leading-[14px] hover:underline"
                  >{{ line(a) }}</a
                >
              } @else {
                <span class="text-foreground min-w-0 truncate font-mono text-[11px] leading-[14px]">{{ line(a) }}</span>
              }
              <span class="flex-1"></span>
              <span class="text-faint font-mono text-[10.5px] leading-[14px] whitespace-nowrap">{{ a.updatedAt | ago }} ago</span>
            </div>
          } @empty {
            <div class="flex items-center gap-2 py-px">
              <svg [lucideIcon]="prIcon" [size]="13" class="text-faint shrink-0" aria-hidden="true"></svg>
              <span class="text-muted-foreground font-mono text-[11px] leading-[14px]">No PR yet</span>
            </div>
          }
        </div>
      </article>
    } @else {
      <article class="border-border flex flex-col gap-2.5 border p-[18px]" aria-label="No Delta thread linked">
        <div class="flex items-center gap-2">
          <span class="border-faint size-2 shrink-0 border" aria-hidden="true"></span>
          <span class="text-faint font-mono text-[10.5px] leading-[14px]">DELTA THREAD</span>
        </div>
        <h3 class="font-title text-foreground text-[20px] leading-[24px] tracking-normal!">No thread linked</h3>
        <p class="text-muted-foreground max-w-[560px] text-[13px] leading-5">
          Open a thread in Delta and type
          <span class="text-foreground font-mono text-[12px]">/trama {{ i.key }}</span> — the agent links it here. One
          thread per task; need another? Create a subtask.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <button hlmBtn variant="outline" type="button" (click)="copyCommand()">
            Copy /trama {{ i.key }} <app-kbd keys="shift+c" />
          </button>
        </div>
      </article>
    }
  `,
})
export class TaskRecord {
  private readonly store = inject(TramaStore);
  private readonly api = inject(ApiClient);
  private readonly clipboard = inject(Clipboard);

  readonly issue = input.required<Issue>();

  protected readonly prIcon = LucideGitPullRequest;

  /** The record `trama sync` keeps for the task; null while it loads, when never synced or without a thread. */
  private readonly loaded = signal<ThreadRecord | null>(null);
  private readonly record = computed(() => {
    const r = this.loaded();
    return r && r.issueId === this.issue().id ? r : null;
  });
  private loadGen = 0;

  protected readonly id = computed(() => threadId(this.issue().threadUrl));
  protected readonly host = computed(() => {
    try {
      return new URL(this.issue().threadUrl ?? '').host;
    } catch {
      return '';
    }
  });
  protected readonly caption = computed(() =>
    this.issue().parentId
      ? "this subtask's own thread — separate from the parent's"
      : 'exactly one per task · linked by the agent via /trama',
  );

  private readonly raw = computed(() => this.store.eventsBySubject().get(`issue:${this.issue().id}`) ?? []);
  private readonly link = computed(() => linkedBy(this.raw()));
  protected readonly by = computed(() => {
    const l = this.link();
    return l ? this.store.actorName(l.actor) : '';
  });
  protected readonly linked = computed(() => {
    const l = this.link();
    return l ? `linked by ${this.store.actorName(l.actor)} · ${format(new Date(l.at), 'MMM d')}` : '';
  });

  /** Id of the newest `trama sync` event of the task: a new one means the record changed, so it is fetched again. */
  private readonly lastSync = computed(() => this.raw().find((e) => e.type === 'issue.thread_synced')?.id ?? '');

  protected readonly sync = computed(() => syncedText(this.record()?.lastSyncAt));
  protected readonly size = computed(() => {
    const r = this.record();
    return r ? recordSize(r) : '';
  });
  protected readonly decisions = computed(() => this.record()?.decisions ?? []);
  protected readonly files = computed(() => recordFiles(this.record()?.files ?? []));

  /**
   * What the agent last synced as the summary; before any sync, the newest comment an agent wrote on the task:
   * the closest thing to the thread's summary Trama has.
   */
  protected readonly report = computed(() => {
    const summary = this.record()?.summary?.trim();
    if (summary) return { text: summary };
    const id = this.issue().id;
    const last = this.store
      .commentsFor({ type: 'issue', id })
      .filter((c) => c.author.type === 'agent')
      .at(-1);
    if (!last) return null;
    const text = last.body.replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim();
    return { text: text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX).trimEnd()}…` : text };
  });

  protected readonly events = computed(() => {
    const entries = buildStream(this.raw(), []);
    return recordEvents(entries, (a) => this.store.actorName(a), this.store.settings().statuses.issue);
  });

  protected readonly artifacts = computed<Artifact[]>(() =>
    sortArtifacts(this.store.artifactsByIssue().get(this.issue().id) ?? []),
  );
  protected readonly requests = computed(() => this.artifacts().filter(isRequest));

  constructor() {
    const issueId = computed(() => this.issue().id);
    const linkedUrl = computed(() => this.issue().threadUrl ?? '');
    effect(() => {
      const id = issueId();
      const linked = !!linkedUrl();
      this.lastSync();
      untracked(() => void this.loadRecord(id, linked));
    });
  }

  private async loadRecord(issueId: string, linked: boolean): Promise<void> {
    const gen = ++this.loadGen;
    const slug = this.store.slug();
    if (!slug || !linked) {
      this.loaded.set(null);
      return;
    }
    try {
      const record = await this.api.threads.record(slug, issueId, { quiet: true });
      if (gen === this.loadGen) this.loaded.set(record);
    } catch (e) {
      // 404: the task was never synced. Any other failure keeps what is shown; the next sync event reloads it.
      if (gen === this.loadGen && ApiError.from(e).isNotFound) this.loaded.set(null);
    }
  }

  protected line(a: Artifact): string {
    return isRequest(a) ? artifactLine(a) : `${a.title} · ${a.state}`;
  }

  protected iconOf(a: Artifact): typeof LucideGitPullRequest {
    if (!isRequest(a)) return LucideFileText;
    return a.state === 'merged' ? LucideGitMerge : LucideGitPullRequest;
  }

  protected when(iso: string): string {
    return format(new Date(iso), 'MMM d HH:mm');
  }

  protected copyLink(url: string): void {
    void this.clipboard.copy(url, 'Thread link copied');
  }

  protected copyCommand(): void {
    void this.clipboard.copy(`/trama ${this.issue().key}`, 'Command copied');
  }
}
