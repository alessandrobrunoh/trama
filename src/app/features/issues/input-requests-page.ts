import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore, type InputRequest } from '../../core';
import { PageHeader } from '../../shared/page-header';

type RequestWithIssue = InputRequest & { issueId?: string };

@Component({
  selector: 'app-input-requests-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, PageHeader],
  template: `
    <main class="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-8">
      <app-page-header
        title="Input requests"
        description="Questions and answers, including legacy requests that are not linked to an issue."
      />
      @if (requests().length) {
        <ul class="border-border divide-border divide-y rounded-lg border">
          @for (request of requests(); track request.id) {
            <li class="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <p class="text-sm font-medium">{{ request.question }}</p>
                <p class="text-muted-foreground mt-1 text-xs">
                  {{ request.state }}
                  @if (issueId(request); as id) {
                    ·
                    <a
                      class="underline underline-offset-2"
                      [routerLink]="['/', slug(), 'issues', issueKey(id)]"
                      >{{ issueKey(id) }}</a
                    >
                  } @else {
                    · Legacy request — not linked to an issue
                  }
                </p>
                @if (request.options?.length) {
                  <p class="text-muted-foreground mt-2 text-xs">
                    Suggested answers: {{ request.options.join(', ') }}
                  </p>
                }
                @if (request.answer) {
                  <p class="mt-2 text-sm">
                    <span class="font-medium">Answer:</span> {{ request.answer }}
                  </p>
                }
              </div>
              @if (request.state === 'open' && store.can('member')) {
                <form
                  class="flex w-full shrink-0 gap-2 sm:max-w-md"
                  (submit)="answer($event, request)"
                >
                  <label class="sr-only" [for]="'answer-' + request.id">Answer this question</label>
                  <input
                    [id]="'answer-' + request.id"
                    [name]="'answer-' + request.id"
                    class="border-input bg-background min-h-10 min-w-0 flex-1 rounded-md border px-3 text-sm"
                    [value]="draft(request.id)"
                    (input)="setDraft(request.id, $any($event.target).value)"
                    required
                  />
                  <button type="submit" hlmBtn size="sm">Answer</button>
                </form>
              }
            </li>
          }
        </ul>
      } @else {
        <p
          class="text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm"
        >
          No input requests yet.
        </p>
      }
    </main>
  `,
})
export class InputRequestsPage {
  protected readonly store = inject(TramaStore);
  private readonly drafts = signal<Record<string, string>>({});
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly requests = computed(() =>
    [...this.store.inputRequests()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  protected issueId(request: InputRequest): string | undefined {
    return (request as RequestWithIssue).issueId;
  }

  protected issueKey(id: string): string {
    return this.store.issueById().get(id)?.key ?? id;
  }

  protected draft(id: string): string {
    return this.drafts()[id] ?? '';
  }

  protected setDraft(id: string, value: string): void {
    this.drafts.update((drafts) => ({ ...drafts, [id]: value }));
  }

  protected async answer(event: Event, request: InputRequest): Promise<void> {
    event.preventDefault();
    const answer = this.draft(request.id).trim();
    if (!answer) return;
    if (await this.store.answerInput(request.id, answer)) {
      this.drafts.update(({ [request.id]: _removed, ...drafts }) => drafts);
    }
  }
}
