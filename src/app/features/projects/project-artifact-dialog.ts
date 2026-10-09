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
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import {
  ARTIFACT_KIND_META,
  TramaStore,
  type Artifact,
  type ArtifactKind,
  type ArtifactProvider,
  type ArtifactState,
} from '../../core';
import { statusLabel } from '../../shared/status';
import { Picker, type PickOption } from '../workstreams/picker';

/** What a new artifact gets attached to. */
export type ArtifactTarget = { type: 'project'; id: string } | { type: 'issue'; key: string };

/** Kinds that make sense for a hand-written document / link (no CI, no review). */
export const DOC_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'document',
  'link',
  'file',
  'design',
  'image',
];

const DOC_STATES: ArtifactState[] = ['draft', 'published'];

const TARGET_LABEL: Record<ArtifactTarget['type'], string> = {
  project: 'this project',
  issue: 'this issue',
};

/** Returns an error message when `value` is not a valid http(s) URL; `null` otherwise (an empty value is valid here). */
export function httpUrlError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? null
      : 'Use an http:// or https:// URL';
  } catch {
    return 'Enter a full URL, e.g. https://example.com/spec';
  }
}

function guessProvider(kind: ArtifactKind, url: string): ArtifactProvider {
  try {
    const host = new URL(url.trim()).hostname.replace(/^www\./, '');
    if (host.endsWith('github.com')) return 'github';
    if (host.endsWith('gitlab.com')) return 'gitlab';
    if (host.endsWith('bitbucket.org')) return 'bitbucket';
    if (host.endsWith('figma.com')) return 'figma';
  } catch {
    // not a URL (yet): fall through to the kind default
  }
  return kind === 'document' ? 'docs' : 'other';
}

/**
 * Dialog to attach a document / link / file / design / image to a project or an issue, or to edit one
 * (title, URL, description, state).
 *   <app-project-artifact-dialog [(open)]="open" [target]="{ type: 'project', id: p.id }" />
 */
@Component({
  selector: 'app-project-artifact-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDialogImports,
    HlmInputImports,
    HlmLabelImports,
    HlmTextareaImports,
    Picker,
  ],
  host: { class: 'contents' },
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] overflow-y-auto sm:max-w-lg"
        (keydown.meta.enter)="submit()"
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle>
            {{ editing() ? 'Edit ' + kindLabel().toLowerCase() : 'Add document / link' }}
          </h2>
          <p hlmDialogDescription>
            @if (editing()) {
              Update how this item is shown. The linked page itself is not touched.
            } @else {
              Attach a spec, a link, a design or a file to {{ targetLabel() }}. It becomes part of
              the shared context.
            }
          </p>
        </hlm-dialog-header>

        <div class="grid gap-3">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Kind</label>
              <app-picker
                label="Kind"
                [searchable]="false"
                [disabled]="editing()"
                [options]="kindOptions"
                [value]="[kind()]"
                (valueChange)="setKind($event[0])"
              />
            </div>
            @if (stateEditable()) {
              <div class="grid min-w-0 gap-1.5">
                <label hlmLabel>State</label>
                <app-picker
                  label="State"
                  [searchable]="false"
                  [options]="stateOptions"
                  [value]="[state()]"
                  (valueChange)="state.set($any($event[0] ?? 'published'))"
                />
              </div>
            }
          </div>

          <div class="grid gap-1.5">
            <label hlmLabel for="pad-title">Title</label>
            <input
              hlmInput
              id="pad-title"
              autocomplete="off"
              placeholder="Product requirements, Figma file, Runbook…"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
          </div>

          <div class="grid gap-1.5">
            <label hlmLabel for="pad-url">
              URL
              @if (kind() !== 'link') {
                <span class="text-muted-foreground font-normal">(optional)</span>
              }
            </label>
            <input
              hlmInput
              id="pad-url"
              type="url"
              inputmode="url"
              autocomplete="off"
              placeholder="https://…"
              [value]="url()"
              [attr.aria-invalid]="touched() && urlError() ? 'true' : null"
              (input)="url.set($any($event.target).value)"
              (blur)="touched.set(true)"
            />
            @if (touched() && urlError(); as err) {
              <p class="text-destructive text-xs" role="alert">{{ err }}</p>
            }
          </div>

          <div class="grid gap-1.5">
            <label hlmLabel for="pad-desc">
              Description
              <span class="text-muted-foreground font-normal">(markdown, optional)</span>
            </label>
            <textarea
              hlmTextarea
              id="pad-desc"
              rows="4"
              placeholder="What is this and why does it matter for the project?"
              [value]="description()"
              (input)="description.set($any($event.target).value)"
            ></textarea>
          </div>
        </div>

        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="busy()" (click)="submit()">
            {{ editing() ? 'Save' : 'Add' }}
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ProjectArtifactDialog {
  private readonly store = inject(TramaStore);

  readonly open = model(false);
  readonly target = input.required<ArtifactTarget>();
  /** When set, the dialog edits this artifact instead of creating one. */
  readonly artifact = input<Artifact>();
  readonly saved = output<Artifact>();

  protected readonly kindOptions: PickOption[] = DOC_ARTIFACT_KINDS.map((k) => ({
    value: k,
    label: ARTIFACT_KIND_META[k].label,
  }));
  protected readonly stateOptions: PickOption[] = DOC_STATES.map((s) => ({
    value: s,
    label: statusLabel(s),
    kind: 'status',
  }));

  protected readonly kind = signal<ArtifactKind>('document');
  protected readonly title = signal('');
  protected readonly url = signal('');
  protected readonly description = signal('');
  protected readonly state = signal<ArtifactState>('published');
  protected readonly busy = signal(false);
  protected readonly touched = signal(false);

  protected readonly editing = computed(() => !!this.artifact());
  /** Items with their own state vocabulary (a PR, a build…) keep it; the picker only covers draft / published. */
  protected readonly stateEditable = computed(() => {
    const a = this.artifact();
    return !a || DOC_STATES.includes(a.state);
  });
  protected readonly targetLabel = computed(() => TARGET_LABEL[this.target().type]);
  protected readonly kindLabel = computed(() => ARTIFACT_KIND_META[this.kind()].label);
  protected readonly urlError = computed<string | null>(() => {
    const v = this.url().trim();
    if (!v) return this.kind() === 'link' ? 'A link needs a URL' : null;
    return httpUrlError(v);
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const a = this.artifact();
      untracked(() => {
        this.kind.set(a?.kind ?? 'document');
        this.title.set(a?.title ?? '');
        this.url.set(a?.url ?? '');
        this.description.set(a?.description ?? '');
        this.state.set(a && DOC_STATES.includes(a.state) ? a.state : 'published');
        this.busy.set(false);
        this.touched.set(false);
      });
    });
  }

  protected setKind(k: string | undefined): void {
    if (k) this.kind.set(k as ArtifactKind);
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.touched.set(true);
    const title = this.title().trim();
    if (!title || this.urlError()) return;
    this.busy.set(true);
    const url = this.url().trim();
    try {
      const current = this.artifact();
      if (current) {
        const patch = {
          title,
          url: url || null,
          description: this.description().trim() || null,
          // Non-document kinds keep their own state vocabulary; only touch it for the draft/published pair.
          ...(DOC_STATES.includes(current.state) ? { state: this.state() } : {}),
        };
        if (await this.store.updateArtifact(current.id, patch)) {
          const next = this.store.artifactById().get(current.id);
          if (next) this.saved.emit(next);
          this.open.set(false);
        }
        return;
      }
      const input = {
        kind: this.kind(),
        provider: guessProvider(this.kind(), url),
        title,
        url: url || undefined,
        description: this.description().trim() || undefined,
        state: this.state(),
      };
      const target = this.target();
      const created =
        target.type === 'project'
          ? await this.store.attachProjectArtifact(target.id, input)
          : await this.store.attachIssueArtifact(target.key, input);
      if (created) {
        this.saved.emit(created);
        this.open.set(false);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
