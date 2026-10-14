import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { TramaStore, type Issue } from '../../core';

type IssueWithGoal = Issue & { goal?: string };

@Component({
  selector: 'app-issue-goal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmTextareaImports],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="issue-goal-heading" class="border-border rounded-lg border px-4 py-3">
      <div class="mb-2 flex items-center justify-between gap-3">
        <h2 id="issue-goal-heading" class="text-sm font-semibold">Goal</h2>
        @if (canEdit() && !editing()) {
          <button type="button" hlmBtn variant="ghost" size="xs" (click)="start()">
            {{ goal() ? 'Edit' : 'Add goal' }}
          </button>
        }
      </div>
      @if (editing()) {
        <form (submit)="save($event)">
          <label for="issue-goal" class="sr-only">Issue goal</label>
          <textarea
            id="issue-goal"
            name="goal"
            hlmTextarea
            rows="3"
            class="w-full resize-y"
            maxlength="4000"
            [value]="draft()"
            (input)="draft.set($any($event.target).value)"
          ></textarea>
          <div class="mt-2 flex justify-end gap-2">
            <button type="button" hlmBtn variant="ghost" size="sm" (click)="editing.set(false)">
              Cancel
            </button>
            <button type="submit" hlmBtn size="sm">Save goal</button>
          </div>
        </form>
      } @else {
        <p class="text-muted-foreground whitespace-pre-wrap text-sm">
          {{
            goal() ||
              (canEdit() ? 'Describe the outcome this issue should achieve.' : 'No goal set.')
          }}
        </p>
      }
    </section>
  `,
})
export class IssueGoal {
  private readonly store = inject(TramaStore);
  readonly issue = input.required<Issue>();
  readonly canEdit = input(false);
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly goal = computed(() => (this.issue() as IssueWithGoal).goal?.trim() ?? '');

  protected start(): void {
    this.draft.set(this.goal());
    this.editing.set(true);
  }

  protected save(event: Event): void {
    event.preventDefault();
    const goal = this.draft().trim();
    void this.store.updateIssue(this.issue().id, { goal: goal || null });
    this.editing.set(false);
  }
}
