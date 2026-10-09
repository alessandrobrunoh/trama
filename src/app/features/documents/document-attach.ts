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
import {
  LucideBox,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideFilePlus,
  LucideFileText,
  LucideHexagon,
  LucidePaperclip,
  LucideSearch,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  ApiError,
  TramaStore,
  Notifier,
  type Document,
  type DocumentLink,
  type DocumentOwnerInput,
  type DocumentSummary,
} from '../../core';
import { isEmojiIcon } from '../projects/project-glyph';
import { Documents } from './documents.service';

type OwnerType = 'project' | 'workstream' | 'issue';

const OWNER_ICON: Record<OwnerType, LucideIcon> = {
  project: LucideBox,
  workstream: LucideHexagon,
  issue: LucideCircleDot,
};

/** What a link of a document points at, resolved for display. `null` when the record is not loaded (anymore). */
export function describeLink(store: TramaStore, link: DocumentLink) {
  const slug = store.slug() ?? '';
  if (link.projectId) {
    const p = store.getProject(link.projectId);
    return p
      ? {
          type: 'project' as const,
          label: p.name,
          mono: false,
          route: ['/', slug, 'projects', p.id],
        }
      : null;
  }
  if (link.workstreamId) {
    const w = store.getWorkstream(link.workstreamId);
    return w
      ? {
          type: 'workstream' as const,
          label: w.key,
          mono: true,
          route: ['/', slug, 'workstreams', w.key],
        }
      : null;
  }
  if (link.issueId) {
    const i = store.getIssue(link.issueId);
    return i
      ? { type: 'issue' as const, label: i.key, mono: true, route: ['/', slug, 'issues', i.key] }
      : null;
  }
  return null;
}

export const OWNER_ICONS = OWNER_ICON;

/** Does this link attach the document to `owner`? */
export function linksTo(link: DocumentLink, owner: DocumentOwnerInput): boolean {
  return (
    (!!owner.projectId && link.projectId === owner.projectId) ||
    (!!owner.workstreamId && link.workstreamId === owner.workstreamId) ||
    (!!owner.issueId && link.issueId === owner.issueId)
  );
}

/**
 * Dialog that attaches `document` to a project, workstream or issue: pick what, done. The document page opens it
 * from "Attach". Already attached places are left out.
 */
@Component({
  selector: 'app-document-owner-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDialogImports, HlmInputImports, LucideDynamicIcon],
  host: { class: 'contents' },
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[85svh] gap-3 sm:max-w-md">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Attach to…</h2>
          <p hlmDialogDescription>
            The document appears in the Artifacts of what you choose, and stays one document.
          </p>
        </hlm-dialog-header>
        <div class="flex gap-1" role="tablist" aria-label="Attach to">
          @for (t of types; track t.type) {
            <button
              type="button"
              role="tab"
              class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-xs transition-colors"
              [class]="
                type() === t.type
                  ? 'border-border-strong bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              "
              [attr.aria-selected]="type() === t.type"
              (click)="type.set(t.type)"
            >
              <svg [lucideIcon]="t.icon" [size]="13"></svg>{{ t.label }}
            </button>
          }
        </div>
        <div class="relative">
          <svg
            [lucideIcon]="searchIcon"
            [size]="14"
            class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          ></svg>
          <input
            hlmInput
            class="h-8 w-full pl-8 text-sm"
            placeholder="Search…"
            aria-label="Search"
            autocomplete="off"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>
        <ul class="-mx-1 max-h-72 overflow-y-auto" role="listbox" aria-label="Choices">
          @for (o of options(); track o.id) {
            <li>
              <button
                type="button"
                class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:opacity-50"
                [disabled]="busy()"
                (click)="pick(o.id)"
              >
                <span class="text-muted-foreground w-16 shrink-0 truncate font-mono text-[11px]">{{
                  o.hint
                }}</span>
                <span class="min-w-0 flex-1 truncate">{{ o.label }}</span>
              </button>
            </li>
          } @empty {
            <li class="text-muted-foreground px-2 py-6 text-center text-xs">
              Nothing to attach to here.
            </li>
          }
        </ul>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class DocumentOwnerDialog {
  private readonly store = inject(TramaStore);
  private readonly documents = inject(Documents);
  private readonly notifier = inject(Notifier);

  readonly open = model(false);
  readonly document = input.required<Document>();
  readonly attached = output<Document>();

  protected readonly searchIcon = LucideSearch;
  protected readonly types: { type: OwnerType; label: string; icon: LucideIcon }[] = [
    { type: 'project', label: 'Project', icon: LucideBox },
    { type: 'workstream', label: 'Workstream', icon: LucideHexagon },
    { type: 'issue', label: 'Issue', icon: LucideCircleDot },
  ];
  protected readonly type = signal<OwnerType>('project');
  protected readonly query = signal('');
  protected readonly busy = signal(false);

  protected readonly options = computed(() => {
    const q = this.query().trim().toLowerCase();
    const links = this.document().links ?? [];
    const has = (f: (l: DocumentLink) => string | undefined, id: string) =>
      links.some((l) => f(l) === id);
    const rows: { id: string; label: string; hint: string }[] =
      this.type() === 'project'
        ? this.store
            .projects()
            .filter((p) => !has((l) => l.projectId, p.id))
            .map((p) => ({ id: p.id, label: p.name, hint: p.status }))
        : this.type() === 'workstream'
          ? this.store
              .workstreams()
              .filter((w) => !has((l) => l.workstreamId, w.id))
              .map((w) => ({ id: w.id, label: w.title, hint: w.key }))
          : this.store
              .issues()
              .filter((i) => !has((l) => l.issueId, i.id))
              .map((i) => ({ id: i.id, label: i.title, hint: i.key }));
    return rows.filter((r) => !q || `${r.hint} ${r.label}`.toLowerCase().includes(q)).slice(0, 60);
  });

  constructor() {
    effect(() => {
      if (this.open()) untracked(() => this.query.set(''));
    });
  }

  protected async pick(id: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const owner: DocumentOwnerInput =
      this.type() === 'project'
        ? { projectId: id }
        : this.type() === 'workstream'
          ? { workstreamId: id }
          : { issueId: id };
    try {
      this.attached.emit(await this.documents.attach(this.document().id, owner));
      this.open.set(false);
    } catch (e) {
      this.notifier.error(e instanceof ApiError ? e.message : 'Could not attach the document');
    } finally {
      this.busy.set(false);
    }
  }
}

/** Dialog that attaches an existing document to `owner` (an issue, workstream or project page). */
@Component({
  selector: 'app-document-picker-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDialogImports, HlmInputImports, LucideDynamicIcon],
  host: { class: 'contents' },
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[85svh] gap-3 sm:max-w-lg">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Attach a document</h2>
          <p hlmDialogDescription>
            Pick a document of this workspace. It appears in the Artifacts here and stays one
            document.
          </p>
        </hlm-dialog-header>
        <div class="relative">
          <svg
            [lucideIcon]="searchIcon"
            [size]="14"
            class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          ></svg>
          <input
            hlmInput
            class="h-8 w-full pl-8 text-sm"
            placeholder="Search documents…"
            aria-label="Search documents"
            autocomplete="off"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>
        <ul class="-mx-1 max-h-80 overflow-y-auto" role="listbox" aria-label="Documents">
          @for (d of rows(); track d.id) {
            <li>
              <button
                type="button"
                class="hover:bg-accent flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left disabled:opacity-50"
                [disabled]="busy()"
                (click)="pick(d)"
              >
                <span
                  class="mt-0.5 flex size-5 shrink-0 items-center justify-center text-base leading-none"
                >
                  @if (emoji(d); as e) {
                    {{ e }}
                  } @else {
                    <svg [lucideIcon]="fileIcon" [size]="16" class="text-muted-foreground"></svg>
                  }
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{{ d.title }}</span>
                  @if (d.excerpt) {
                    <span class="text-muted-foreground block truncate text-xs">{{
                      d.excerpt
                    }}</span>
                  }
                </span>
              </button>
            </li>
          } @empty {
            <li class="text-muted-foreground px-2 py-6 text-center text-xs">
              {{
                loading()
                  ? 'Searching…'
                  : query()
                    ? 'No document matches.'
                    : 'No documents to attach yet.'
              }}
            </li>
          }
        </ul>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="busy()" (click)="createNew()">
            <svg [lucideIcon]="newIcon" [size]="14"></svg>New document
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class DocumentPickerDialog {
  private readonly documents = inject(Documents);
  private readonly notifier = inject(Notifier);

  readonly open = model(false);
  readonly owner = input.required<DocumentOwnerInput>();

  protected readonly searchIcon = LucideSearch;
  protected readonly fileIcon = LucideFileText;
  protected readonly newIcon = LucideFilePlus;
  protected readonly query = signal('');
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  private readonly found = signal<DocumentSummary[]>([]);
  private requestId = 0;

  /** Documents not already attached here. */
  protected readonly rows = computed(() =>
    this.found().filter((d) => !(d.links ?? []).some((l) => linksTo(l, this.owner()))),
  );

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const q = this.query().trim();
      this.documents.changes();
      const id = ++this.requestId;
      this.loading.set(true);
      const timer = setTimeout(
        () => {
          this.documents
            .list({ q: q || undefined, limit: 40, sort: q ? undefined : 'updated' })
            .then((rows) => id === this.requestId && this.found.set(rows))
            .catch(() => id === this.requestId && this.found.set([]))
            .finally(() => id === this.requestId && this.loading.set(false));
        },
        q ? 200 : 0,
      );
      onCleanup(() => clearTimeout(timer));
    });
    effect(() => {
      if (this.open()) untracked(() => this.query.set(''));
    });
  }

  protected emoji(d: DocumentSummary): string | null {
    return isEmojiIcon(d.icon) ? d.icon : null;
  }

  protected async pick(d: DocumentSummary): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.documents.attach(d.id, this.owner());
      this.notifier.success('Document attached', { description: d.title, duration: 2500 });
      this.open.set(false);
    } catch (e) {
      this.notifier.error(e instanceof ApiError ? e.message : 'Could not attach the document');
    } finally {
      this.busy.set(false);
    }
  }

  protected async createNew(): Promise<void> {
    this.busy.set(true);
    try {
      this.open.set(false);
      await this.documents.createAndOpen(this.owner());
    } finally {
      this.busy.set(false);
    }
  }
}

/**
 * "Documents" button for the Artifacts section of a project, workstream or issue: write a new document there or
 * attach an existing one. Shown to people who can edit.
 *   <app-document-actions [owner]="{ issueId: issue().id }" />
 */
@Component({
  selector: 'app-document-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDropdownMenuImports, LucideDynamicIcon, DocumentPickerDialog],
  host: { class: 'inline-flex' },
  template: `
    <button
      hlmBtn
      size="sm"
      [variant]="variant()"
      class="h-7 gap-1.5 text-xs"
      [hlmDropdownMenuTrigger]="menu"
      [attr.aria-label]="label() + ': new or existing document'"
    >
      <svg [lucideIcon]="fileIcon" [size]="13"></svg>{{ label() }}
    </button>
    <ng-template #menu>
      <hlm-dropdown-menu class="w-52">
        <button hlmDropdownMenuItem (triggered)="create()">
          <svg [lucideIcon]="newIcon" [size]="14"></svg>New document
        </button>
        <button hlmDropdownMenuItem (triggered)="picking.set(true)">
          <svg [lucideIcon]="attachIcon" [size]="14"></svg>Attach existing…
        </button>
      </hlm-dropdown-menu>
    </ng-template>
    <app-document-picker-dialog [(open)]="picking" [owner]="owner()" />
  `,
})
export class DocumentActions {
  private readonly documents = inject(Documents);

  readonly owner = input.required<DocumentOwnerInput>();
  readonly variant = input<'ghost' | 'outline' | 'default'>('ghost');
  readonly label = input('Document');

  protected readonly fileIcon = LucideFileText;
  protected readonly newIcon = LucideFilePlus;
  protected readonly attachIcon = LucidePaperclip;
  protected readonly picking = signal(false);

  protected create(): void {
    void this.documents.createAndOpen(this.owner());
  }
}
