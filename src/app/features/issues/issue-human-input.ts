import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { TramaStore, type Decision, type InputRequest, type Issue } from '../../core';

type IssueLinkedRequest = InputRequest & { issueId?: string };
type IssueLinkedDecision = Decision & { originIssueId?: string };

@Component({
  selector: 'app-issue-human-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmTextareaImports],
  host: { class: 'block' },
  template: `
    <section
      aria-labelledby="human-input-heading"
      class="border-border rounded-lg border px-4 py-3"
    >
      <div class="mb-1">
        <h2 id="human-input-heading" class="text-sm font-semibold">Human input</h2>
        <p class="text-muted-foreground mt-1 text-xs">
          Ask a question or record a decision about this issue.
        </p>
      </div>

      <form class="mt-3 flex flex-col gap-3" (submit)="submit($event)">
        <fieldset>
          <legend class="text-muted-foreground mb-2 text-xs font-medium">What do you need?</legend>
          <div class="flex flex-wrap gap-3">
            <label class="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="human-input-mode"
                value="question"
                [checked]="mode() === 'question'"
                (change)="mode.set('question')"
              />
              Question
            </label>
            <label class="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="human-input-mode"
                value="decision"
                [checked]="mode() === 'decision'"
                (change)="mode.set('decision')"
              />
              Decision
            </label>
          </div>
        </fieldset>

        @if (mode() === 'question') {
          <div>
            <label for="human-input-question" class="mb-1 block text-sm font-medium"
              >Question</label
            >
            <textarea
              id="human-input-question"
              name="question"
              hlmTextarea
              rows="2"
              class="w-full resize-y"
              maxlength="2000"
              required
              [value]="question()"
              (input)="question.set($any($event.target).value)"
            ></textarea>
            <label for="human-input-options" class="text-muted-foreground mt-2 mb-1 block text-xs"
              >Suggested answers (optional, one per line)</label
            >
            <textarea
              id="human-input-options"
              name="options"
              hlmTextarea
              rows="2"
              class="w-full resize-y"
              [value]="options()"
              (input)="options.set($any($event.target).value)"
            ></textarea>
          </div>
        } @else {
          <div class="flex flex-col gap-3">
            <div>
              <label for="human-input-title" class="mb-1 block text-sm font-medium"
                >Decision title</label
              >
              <input
                id="human-input-title"
                name="title"
                class="border-input bg-background min-h-10 w-full rounded-md border px-3 text-sm"
                maxlength="300"
                required
                [value]="title()"
                (input)="title.set($any($event.target).value)"
              />
            </div>
            <div>
              <label for="human-input-statement" class="mb-1 block text-sm font-medium"
                >Decision</label
              >
              <textarea
                id="human-input-statement"
                name="statement"
                hlmTextarea
                rows="3"
                class="w-full resize-y"
                required
                [value]="statement()"
                (input)="statement.set($any($event.target).value)"
              ></textarea>
            </div>
            <div>
              <label for="human-input-rationale" class="mb-1 block text-sm font-medium"
                >Why (optional)</label
              >
              <textarea
                id="human-input-rationale"
                name="rationale"
                hlmTextarea
                rows="2"
                class="w-full resize-y"
                [value]="rationale()"
                (input)="rationale.set($any($event.target).value)"
              ></textarea>
            </div>
          </div>
        }
        <div class="flex items-center justify-between gap-3">
          <p aria-live="polite" class="text-muted-foreground text-xs">{{ feedback() }}</p>
          <button type="submit" hlmBtn size="sm" [disabled]="disabled() || busy()">
            {{ mode() === 'question' ? 'Ask question' : 'Propose decision' }}
          </button>
        </div>
      </form>

      @if (linkedRequests().length || linkedDecisions().length) {
        <div class="border-border mt-4 border-t pt-3">
          <h3 class="text-muted-foreground mb-2 text-xs font-medium">Linked human input</h3>
          <ul class="flex flex-col gap-2">
            @for (request of linkedRequests(); track request.id) {
              <li class="text-sm">
                <span class="font-medium">Question · </span>{{ request.question }}
                <span class="text-muted-foreground ml-1 text-xs">({{ request.state }})</span>
              </li>
            }
            @for (decision of linkedDecisions(); track decision.id) {
              <li class="text-sm">
                <span class="font-medium">Decision · </span>{{ decision.title }}
                <span class="text-muted-foreground ml-1 text-xs">({{ decision.status }})</span>
              </li>
            }
          </ul>
        </div>
      }
    </section>
  `,
})
export class IssueHumanInput {
  private readonly store = inject(TramaStore);
  readonly issue = input.required<Issue>();
  readonly disabled = input(false);
  protected readonly mode = signal<'question' | 'decision'>('question');
  protected readonly question = signal('');
  protected readonly options = signal('');
  protected readonly title = signal('');
  protected readonly statement = signal('');
  protected readonly rationale = signal('');
  protected readonly busy = signal(false);
  protected readonly feedback = signal('');
  protected readonly linkedRequests = computed(() =>
    this.store
      .inputRequests()
      .filter((request) => (request as IssueLinkedRequest).issueId === this.issue().id),
  );
  protected readonly linkedDecisions = computed(() =>
    this.store
      .decisions()
      .filter((decision) => (decision as IssueLinkedDecision).originIssueId === this.issue().id),
  );

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.disabled() || this.busy()) return;
    this.busy.set(true);
    this.feedback.set('');
    try {
      if (this.mode() === 'question') {
        const options = this.options()
          .split('\n')
          .map((option) => option.trim())
          .filter(Boolean);
        if (options.length > 10) {
          this.feedback.set('Use 10 or fewer suggested answers.');
          return;
        }
        const created = await this.store.createInputRequest({
          issueId: this.issue().id,
          question: this.question().trim(),
          options: options.length ? options : undefined,
        });
        if (created) {
          this.question.set('');
          this.options.set('');
          this.feedback.set('Question sent.');
        }
      } else {
        const created = await this.store.proposeDecision({
          title: this.title().trim(),
          statement: this.statement().trim(),
          rationale: this.rationale().trim() || undefined,
          originIssueId: this.issue().id,
        });
        if (created) {
          this.title.set('');
          this.statement.set('');
          this.rationale.set('');
          this.feedback.set('Decision proposed.');
        }
      }
    } finally {
      this.busy.set(false);
    }
  }
}
