// Activity: domain events and comments of a workstream, newest first, with a comment composer.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, fullDate, shortDate, type Comment, type DomainEvent, type Workstream } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { RelativeTimePipe } from '../../shared/pipes';
import { describeEvent, type EventLine } from './activity-format';
import { CommentComposer, CommentItem, CommentsLoader } from './comments';

type Entry =
  | { kind: 'event'; at: string; id: string; ev: DomainEvent; line: EventLine }
  | { kind: 'comment'; at: string; id: string; comment: Comment };

interface Day {
  label: string;
  entries: Entry[];
}

const PAGE = 30;

@Component({
  selector: 'app-ws-activity-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmTooltip, LucideDynamicIcon, ActorAvatar, CommentComposer, CommentItem, CommentsLoader, RelativeTimePipe],
  host: { class: 'block' },
  template: `
    <div class="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      @if (canEdit()) {
        <app-comment-composer #composer class="mb-6" placeholder="Comment on this workstream…" (submitted)="send($event, composer)" />
      }

      @for (d of days(); track d.label) {
        <h3 class="text-muted-foreground mt-4 mb-2 text-xs font-medium first:mt-0">{{ d.label }}</h3>
        <ol class="flex flex-col">
          @for (e of d.entries; track e.id) {
            @if (e.kind === 'comment') {
              <li class="my-1.5"><app-comment-item [comment]="e.comment" /></li>
            } @else {
              <li
                class="flex items-start gap-2.5 rounded-md px-1.5 py-1.5"
                [class]="e.ev.actor.type === 'agent' ? 'bg-primary/5' : ''"
              >
                <span class="relative mt-0.5 flex size-5 shrink-0 items-center justify-center">
                  <app-actor-avatar [actor]="e.ev.actor" [size]="20" />
                </span>
                <div class="min-w-0 flex-1 text-sm">
                  <span class="text-foreground font-medium">{{ store.actorName(e.ev.actor) }}</span>
                  @if (e.ev.actor.type === 'agent') {
                    <span class="text-primary bg-primary/10 mx-1 rounded px-1 text-[10px] font-medium uppercase">agent</span>
                  }
                  <span class="text-muted-foreground"> {{ e.line.verb }}</span>
                  @if (e.line.detail) {
                    @if (e.line.link) {
                      <a [routerLink]="['/', slug(), ...e.line.link]" class="text-foreground ml-1 hover:underline">{{ e.line.detail }}</a>
                    } @else {
                      <span class="text-foreground ml-1">{{ e.line.detail }}</span>
                    }
                  }
                </div>
                <svg [lucideIcon]="e.line.icon" [size]="13" class="text-muted-foreground mt-1 shrink-0"></svg>
                <span class="text-muted-foreground mt-0.5 w-20 shrink-0 text-right text-xs whitespace-nowrap" [hlmTooltip]="full(e.at)" position="left">{{ e.at | relativeTime }}</span>
              </li>
            }
          }
        </ol>
      } @empty {
        <p class="text-muted-foreground py-6 text-center text-sm">No activity yet.</p>
      }

      <app-comments-loader [subject]="subject()" class="mt-4" />

      @if (hasMore()) {
        <div class="mt-4 flex justify-center">
          <button hlmBtn variant="outline" size="sm" [disabled]="loading()" (click)="more()">{{ loading() ? 'Loading…' : 'Load older' }}</button>
        </div>
      }
    </div>
  `,
})
export class WsActivityTab {
  protected readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  protected readonly visible = signal(PAGE);
  protected readonly loading = signal(false);
  protected readonly exhausted = signal(false);
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly subject = computed(() => ({ type: 'workstream' as const, id: this.ws().id }));
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly full = fullDate;

  private readonly entries = computed<Entry[]>(() => {
    const w = this.ws();
    const events = this.store.eventsByWorkstream().get(w.id) ?? [];
    const comments = this.store.commentsFor({ type: 'workstream', id: w.id });
    const out: Entry[] = [];
    for (const ev of events) {
      // comments on the workstream itself are rendered as comments, not as "commented" events
      if (ev.type === 'comment.created' && ev.subject.type === 'workstream') continue;
      out.push({ kind: 'event', at: ev.at, id: ev.id, ev, line: describeEvent(this.store, ev) });
    }
    for (const c of comments) out.push({ kind: 'comment', at: c.createdAt, id: c.id, comment: c });
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  });

  protected readonly days = computed<Day[]>(() => {
    const out: Day[] = [];
    for (const e of this.entries().slice(0, this.visible())) {
      const label = shortDate(e.at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.entries.push(e);
      else out.push({ label, entries: [e] });
    }
    return out;
  });

  protected readonly hasMore = computed(() => this.visible() < this.entries().length || !this.exhausted());

  protected async more(): Promise<void> {
    if (this.visible() < this.entries().length) {
      this.visible.update((v) => v + PAGE);
      return;
    }
    this.loading.set(true);
    const n = await this.store.loadOlderEvents({ workstreamId: this.ws().id, limit: 50 });
    this.loading.set(false);
    if (!n) this.exhausted.set(true);
    else this.visible.update((v) => v + n);
  }

  protected async send(body: string, composer: CommentComposer): Promise<void> {
    await this.store.addComment({ type: 'workstream', id: this.ws().id }, body);
    composer.reset();
  }
}
