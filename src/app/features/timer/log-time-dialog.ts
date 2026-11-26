// Log time dialog (v3 · 25): add a past session to a task. Open it with `inject(LogTimeDialogService).open()`
// (optionally prefilled) and mount `<app-log-time-dialog />` once on the page that offers it.
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { LucideCalendar, LucideDynamicIcon, LucideSparkles } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmKbd } from '@spartan-ng/helm/kbd';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import { Notifier } from '../../core/notify/notifier';
import { TramaStore } from '../../core/stores/trama.store';
import { AppSelect, type Option } from '../../shared/app-select';
import { DatePicker } from '../../shared/date-picker';
import { Kbd } from '../../shared/kbd';
import { V3_TEXTAREA, V3DialogFoot, V3DialogHead, V3Field } from '../../shared/v3';

/** What the dialog opens with. Everything is optional. */
export interface LogTimeRequest {
  issueId?: string;
  description?: string;
  date?: Date;
  /** "HH:MM" */
  start?: string;
  /** "HH:MM" */
  end?: string;
  /** Mono banner above the form: "From thread th_8f2a19 · 6 turns between 07:30 and 07:55". */
  banner?: string;
  /** Called after the entry was saved (reload the list). */
  onLogged?: () => void;
}

@Injectable({ providedIn: 'root' })
export class LogTimeDialogService {
  readonly request = signal<LogTimeRequest | null>(null);

  open(request: LogTimeRequest = {}): void {
    this.request.set(request);
  }

  close(): void {
    this.request.set(null);
  }
}

const QUICK: readonly { label: string; minutes: number }[] = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
];

const pad = (n: number): string => String(n).padStart(2, '0');

/** `date` at "HH:MM" in the local time zone. */
function at(date: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const out = new Date(date);
  out.setHours(h, m, 0, 0);
  return out;
}

const toMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const toTime = (minutes: number): string => {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
};

/** "25m" · "1h" · "1h 30m" · "1.5h" · "1:30" → minutes, or null when it does not read as a duration. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  let m = /^(\d+):(\d{2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60 + Number(m[2] ?? 0));
  m = /^(\d+)\s*m?$/.exec(t);
  return m ? Number(m[1]) : null;
}

/** 25 → "25m", 90 → "1h 30m". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

@Component({
  selector: 'app-log-time-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    HlmDialogImports,
    HlmButtonImports,
    HlmKbd,
    Kbd,
    LucideDynamicIcon,
    AppSelect,
    DatePicker,
    V3DialogHead,
    V3DialogFoot,
    V3Field,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="service.close()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:-top-[8.5svh] sm:w-[600px] sm:max-w-[600px]"
        [showCloseButton]="false"
        (keydown.meta.enter)="submit($event)"
        (keydown.control.enter)="submit($event)"
      >
        <v3-dialog-head kicker="TIME" (dismiss)="service.close()">
          <h2 hlmDialogTitle>Log time</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">Add a past session of work to a task.</p>

        <form class="flex flex-col gap-3.5 p-[18px]" novalidate (submit)="submit($event)">
          @if (banner(); as b) {
            <div
              class="bg-delta-line/[0.06] border-delta-line text-delta flex items-center gap-2.5 border-l-2 px-3 py-[9px] font-mono text-[10.5px] leading-[14px]"
            >
              <svg [lucideIcon]="sparklesIcon" [size]="13" aria-hidden="true"></svg>
              {{ b }}
            </div>
          }
          @if (error(); as e) {
            <p class="text-red font-mono text-[10.5px]" role="alert">{{ e }}</p>
          }

          <v3-field label="TASK" for="log-task">
            <app-select controlId="log-task" label="Task" [options]="issueChoices()" [(value)]="issueId" />
          </v3-field>

          <div class="flex gap-3 max-sm:flex-col">
            <v3-field class="flex-1" label="DATE">
              <app-date-picker
                label="Day of the session"
                triggerClass="bg-background border-border h-[34px] w-full justify-start gap-2 border px-2.5 text-[13px]"
                class="w-full"
                [value]="date().toISOString()"
                (dateChange)="date.set($event ?? today())"
              >
                <svg [lucideIcon]="calendarIcon" [size]="13" class="text-muted-foreground" aria-hidden="true"></svg>
                <span>{{ date() | date: 'EEE, MMM d' }}</span>
              </app-date-picker>
            </v3-field>
            <v3-field class="flex-1" label="START – END">
              <div
                class="bg-background border-border focus-within:border-primary flex h-[34px] items-center gap-1.5 border px-2.5 transition-colors"
              >
                <input
                  type="time"
                  class="w-[5.5ch] min-w-0 bg-transparent text-[13px] outline-none"
                  aria-label="Start"
                  required
                  [value]="start()"
                  (input)="setStart($any($event.target).value)"
                />
                <span class="text-faint" aria-hidden="true">–</span>
                <input
                  type="time"
                  class="w-[5.5ch] min-w-0 bg-transparent text-[13px] outline-none"
                  aria-label="End"
                  required
                  [value]="end()"
                  (input)="setEnd($any($event.target).value)"
                />
              </div>
            </v3-field>
            <v3-field class="w-[120px] max-sm:w-full" label="DURATION" for="log-duration">
              <input
                id="log-duration"
                class="bg-background border-border text-foreground focus-visible:border-primary h-[34px] w-full min-w-0 border px-2.5 text-[13px] outline-none transition-colors"
                autocomplete="off"
                placeholder="25m"
                [value]="durationText()"
                (input)="setDuration($any($event.target).value)"
              />
            </v3-field>
          </div>

          <v3-field label="NOTE" for="log-note">
            <textarea
              id="log-note"
              [class]="textareaClass"
              class="h-[60px]"
              rows="2"
              placeholder="What did you work on?"
              [value]="note()"
              (input)="note.set($any($event.target).value)"
            ></textarea>
          </v3-field>

          <div class="flex items-center gap-1.5">
            <span class="text-faint font-mono text-[10px]">QUICK</span>
            @for (q of quick; track q.label) {
              <button
                type="button"
                class="border-border text-muted-foreground hover:text-foreground hover:bg-hover border px-2 py-[3px] font-mono text-[11px]"
                (click)="setMinutes(q.minutes)"
              >
                {{ q.label }}
              </button>
            }
          </div>
        </form>

        <v3-dialog-foot [hint]="banner() ? 'prefilled from a suggestion' : ''">
          <button hlmBtn type="button" variant="outline" (click)="service.close()">
            Cancel <kbd hlmKbd class="h-4">esc</kbd>
          </button>
          <button hlmBtn type="button" [disabled]="busy() || !valid()" (click)="submit($event)">
            {{ minutes() ? 'Log ' + durationLabel() : 'Log time' }}
            <app-kbd keys="mod+enter" class="[&_kbd]:h-4" />
          </button>
        </v3-dialog-foot>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class LogTimeDialog {
  protected readonly service = inject(LogTimeDialogService);
  private readonly api = inject(ApiClient);
  private readonly store = inject(TramaStore);
  private readonly notifier = inject(Notifier);

  protected readonly calendarIcon = LucideCalendar;
  protected readonly sparklesIcon = LucideSparkles;
  protected readonly textareaClass = V3_TEXTAREA;
  protected readonly quick = QUICK;

  protected readonly open = computed(() => this.service.request() !== null);
  protected readonly banner = computed(() => this.service.request()?.banner ?? '');

  protected readonly issueId = signal('');
  protected readonly date = signal(new Date());
  protected readonly start = signal('');
  protected readonly end = signal('');
  /** What is typed in the duration field; kept apart so half-typed text is not rewritten. */
  protected readonly durationText = signal('');
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly issueChoices = computed<Option[]>(() => [
    { value: '', label: 'No task' },
    ...this.store.issues().map((issue) => ({
      value: issue.id,
      label: `${issue.key} · ${issue.title}`,
      hint: issue.key,
    })),
  ]);

  /** Minutes between start and end (end after midnight is not supported: the day is one date). */
  protected readonly minutes = computed(() => {
    if (!this.start() || !this.end()) return 0;
    return Math.max(0, toMinutes(this.end()) - toMinutes(this.start()));
  });
  protected readonly durationLabel = computed(() => formatDuration(this.minutes()));
  protected readonly valid = computed(() => this.minutes() > 0);

  constructor() {
    // Each time the dialog opens, start from the request it was opened with.
    effect(() => {
      const r = this.service.request();
      if (!r) return;
      untracked(() => {
        const now = new Date();
        const end = r.end ?? `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const start = r.start ?? toTime(toMinutes(end) - 25);
        this.issueId.set(r.issueId && this.store.issueById().has(r.issueId) ? r.issueId : '');
        this.date.set(r.date ?? now);
        this.start.set(start);
        this.end.set(end);
        this.durationText.set(formatDuration(Math.max(0, toMinutes(end) - toMinutes(start))));
        this.note.set(r.description ?? '');
        this.busy.set(false);
        this.error.set('');
      });
    });
  }

  protected today(): Date {
    return new Date();
  }

  protected setStart(value: string): void {
    this.start.set(value);
    this.syncDuration();
  }

  protected setEnd(value: string): void {
    this.end.set(value);
    this.syncDuration();
  }

  /** Typing a duration moves the end of the session (the start stays). */
  protected setDuration(text: string): void {
    this.durationText.set(text);
    const minutes = parseDuration(text);
    if (minutes && this.start()) this.end.set(toTime(toMinutes(this.start()) + minutes));
  }

  protected setMinutes(minutes: number): void {
    this.durationText.set(formatDuration(minutes));
    if (this.start()) this.end.set(toTime(toMinutes(this.start()) + minutes));
  }

  private syncDuration(): void {
    const m = this.minutes();
    if (m > 0) this.durationText.set(formatDuration(m));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const slug = this.store.slug();
    if (!slug || this.busy()) return;
    if (!this.valid()) {
      this.error.set('The end time must be after the start time.');
      return;
    }
    const startedAt = at(this.date(), this.start());
    const endedAt = at(this.date(), this.end());
    const issue = this.issueId() ? this.store.getIssue(this.issueId()) : undefined;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.timeEntries.add(
        slug,
        {
          description: this.note().trim(),
          projectId: issue?.projectId ?? null,
          issueId: issue?.id ?? null,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
        },
        { quiet: true },
      );
      this.notifier.success(`Logged ${this.durationLabel()}`, {
        description: issue ? `${issue.key} · ${issue.title}` : undefined,
      });
      const done = this.service.request()?.onLogged;
      this.service.close();
      done?.();
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
