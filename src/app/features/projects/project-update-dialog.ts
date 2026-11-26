// Post (or edit) a project update (v3 dialog style, like "Log time"): a markdown textarea, the health to report with
// it, and a draft from the project's AI summary. Mount it on the Updates tab and bind `open`; pass `editing` to
// change a posted update instead of posting a new one.
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
import { LucideDynamicIcon, LucideSparkles } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmKbd } from '@spartan-ng/helm/kbd';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import {
  PROJECT_UPDATE_BODY_MAX,
  type Project,
  type ProjectUpdate,
} from '../../core/contracts/domain';
import { AssistantStore } from '../../core/ai/assistant.store';
import { TramaStore } from '../../core/stores/trama.store';
import { AppSelect, type Option } from '../../shared/app-select';
import { Kbd } from '../../shared/kbd';
import { V3_TEXTAREA, V3DialogFoot, V3DialogHead, V3Field } from '../../shared/v3';
import { ProjectUpdatesStore } from './project-updates.store';

@Component({
  selector: 'app-project-update-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmDialogImports,
    HlmButtonImports,
    HlmKbd,
    HlmSpinner,
    Kbd,
    LucideDynamicIcon,
    AppSelect,
    V3DialogHead,
    V3DialogFoot,
    V3Field,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:w-[600px] sm:max-w-[600px]"
        [showCloseButton]="false"
        (keydown.meta.enter)="submit($event)"
        (keydown.control.enter)="submit($event)"
      >
        <v3-dialog-head kicker="PROJECT UPDATE" (dismiss)="open.set(false)">
          <h2 hlmDialogTitle>{{ editing() ? 'Edit update' : 'Post update' }}</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">
          Write where {{ project().name }} stands. The first paragraph becomes the headline of the Updates tab.
        </p>

        <form class="flex flex-col gap-3.5 p-[18px]" novalidate (submit)="submit($event)">
          @if (error(); as e) {
            <p class="text-red font-mono text-[10.5px]" role="alert">{{ e }}</p>
          }

          <v3-field label="UPDATE · MARKDOWN" for="project-update-body">
            <textarea
              id="project-update-body"
              [class]="textareaClass"
              class="h-[180px]"
              rows="8"
              placeholder="Where does {{ project().name }} stand? What changed since the last update?"
              [attr.maxlength]="max"
              [value]="body()"
              (input)="body.set($any($event.target).value)"
            ></textarea>
          </v3-field>

          <div class="flex items-end gap-3 max-sm:flex-col max-sm:items-stretch">
            <v3-field class="flex-1" label="HEALTH" for="project-update-health">
              <app-select
                controlId="project-update-health"
                label="Health"
                [options]="healthOptions()"
                [(value)]="health"
              />
            </v3-field>
            <button
              hlmBtn
              type="button"
              variant="outline"
              class="h-[34px] gap-1.5"
              [disabled]="drafting() || !aiReady()"
              [attr.aria-busy]="drafting()"
              [title]="aiReady() ? 'Fill the text from the AI summary of the project' : 'AI is not configured for this workspace'"
              (click)="draft()"
            >
              @if (drafting()) {
                <hlm-spinner class="size-3.5" aria-label="Drafting" />
                Drafting…
              } @else {
                <svg [lucideIcon]="sparklesIcon" [size]="14" aria-hidden="true"></svg>
                Draft with AI
              }
            </button>
          </div>
          @if (draftError(); as e) {
            <p class="text-faint font-mono text-[10.5px]" role="status">{{ e }}</p>
          }
        </form>

        <v3-dialog-foot [hint]="body().length + ' / ' + max">
          <button hlmBtn type="button" variant="outline" (click)="open.set(false)">
            Cancel <kbd hlmKbd class="h-4">esc</kbd>
          </button>
          <button hlmBtn type="button" [disabled]="busy() || !valid()" (click)="submit($event)">
            {{ editing() ? 'Save' : 'Post update' }}
            <app-kbd keys="mod+enter" class="[&_kbd]:h-4" />
          </button>
        </v3-dialog-foot>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ProjectUpdateDialog {
  readonly project = input.required<Project>();
  /** The update being changed; `null` posts a new one. */
  readonly editing = input<ProjectUpdate | null>(null);
  readonly open = model(false);

  private readonly store = inject(TramaStore);
  private readonly updates = inject(ProjectUpdatesStore);
  private readonly assistant = inject(AssistantStore);

  protected readonly max = PROJECT_UPDATE_BODY_MAX;
  protected readonly sparklesIcon = LucideSparkles;
  protected readonly textareaClass = V3_TEXTAREA;

  protected readonly body = signal('');
  protected readonly health = signal('');
  protected readonly busy = signal(false);
  protected readonly drafting = signal(false);
  protected readonly error = signal('');
  protected readonly draftError = signal('');

  protected readonly aiReady = computed(() => this.assistant.status() === null || this.assistant.ready());
  protected readonly valid = computed(() => {
    const n = this.body().trim().length;
    return n > 0 && this.body().length <= PROJECT_UPDATE_BODY_MAX;
  });

  /** The project health catalog; the first choice leaves the health as it is. */
  protected readonly healthOptions = computed<Option[]>(() => [
    { value: '', label: this.editing() ? 'No health' : 'Keep the current health' },
    ...this.store.settings().statuses.projectHealth.map((h) => ({ value: h.id, label: h.name })),
  ]);

  constructor() {
    // Each time the dialog opens, start from the update being edited (or empty).
    effect(() => {
      if (!this.open()) return;
      const update = untracked(() => this.editing());
      untracked(() => {
        this.body.set(update?.body ?? '');
        this.health.set(update?.health ?? '');
        this.busy.set(false);
        this.drafting.set(false);
        this.error.set('');
        this.draftError.set('');
      });
    });
  }

  protected async draft(): Promise<void> {
    if (this.drafting()) return;
    const id = this.project().id;
    this.drafting.set(true);
    this.draftError.set('');
    try {
      const result = await this.store.aiProject(id, 'summary');
      if (!this.open() || this.project().id !== id) return;
      if (!result) {
        this.draftError.set('No draft this time. Check the notification for details, then try again.');
        return;
      }
      const text = [result.summary, result.description].map((s) => s.trim()).filter(Boolean).join('\n\n');
      this.body.set(text.slice(0, PROJECT_UPDATE_BODY_MAX));
    } finally {
      this.drafting.set(false);
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.valid()) return;
    const project = this.project();
    const update = this.editing();
    const body = this.body().trim();
    const health = this.health();
    this.busy.set(true);
    this.error.set('');
    const ok = update
      ? await this.updates.edit(project.id, update.id, {
          body,
          ...(health !== (update.health ?? '') ? { health: health || null } : {}),
        })
      : await this.updates.create(project.id, { body, ...(health ? { health } : {}) });
    this.busy.set(false);
    if (ok) this.open.set(false);
    else this.error.set(update ? 'The update could not be saved.' : 'The update could not be posted.');
  }
}
