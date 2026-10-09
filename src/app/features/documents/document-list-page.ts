import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  type ElementRef,
} from '@angular/core';
import {
  LucideDynamicIcon,
  LucideFilePlus,
  LucideFileText,
  LucideSearch,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  ApiError,
  TramaStore,
  Notifier,
  usePageShortcuts,
  type DocumentSummary,
  type DocumentsQuery,
} from '../../core';
import { oneOf, readJson, writeJson } from '../../core/stores/storage';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { Picker, type PickOption } from '../workstreams/picker';
import { DocumentRow } from './document-row';
import { Documents } from './documents.service';

const PAGE = 50;
const DISPLAY_KEY = 'trama.documents.list.v1';
type Sort = 'updated' | 'created' | 'title';
const SORTS: readonly Sort[] = ['updated', 'created', 'title'];
const SORT_LABEL: Record<Sort, string> = {
  updated: 'Last edited',
  created: 'Newest',
  title: 'Title',
};

/** The documents of the workspace: search (title and text), filter by project, author and attachment, sort. */
@Component({
  selector: 'app-document-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    LucideDynamicIcon,
    PageHeader,
    Picker,
    Kbd,
    EmptyState,
    TopBarActions,
    DocumentRow,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canCreate()) {
        <button hlmBtn size="sm" (click)="create()" [disabled]="creating()">
          <svg [lucideIcon]="newIcon" [size]="14"></svg>
          <span>New document</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header
      title="Documents"
      description="Specs, plans and notes that do not live in a repository"
    />

    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-1.5 sm:px-6">
      <div class="relative w-full sm:w-72">
        <svg
          [lucideIcon]="searchIcon"
          [size]="14"
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
        ></svg>
        <input
          #searchBox
          hlmInput
          class="h-7 w-full pl-8 text-xs"
          type="search"
          placeholder="Search titles and text…"
          aria-label="Search documents"
          autocomplete="off"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
          (keydown.escape)="search.set(''); searchBox.blur()"
        />
      </div>
      <div
        class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full"
      >
        <button
          type="button"
          class="h-7 shrink-0 rounded-md border px-2 text-xs transition-colors"
          [class]="
            mine()
              ? 'border-border-strong bg-accent text-foreground'
              : 'border-dashed text-muted-foreground hover:text-foreground'
          "
          [attr.aria-pressed]="mine()"
          (click)="mine.set(!mine())"
        >
          Mine
        </button>
        <button
          type="button"
          class="h-7 shrink-0 rounded-md border px-2 text-xs transition-colors"
          [class]="
            loose()
              ? 'border-border-strong bg-accent text-foreground'
              : 'border-dashed text-muted-foreground hover:text-foreground'
          "
          [attr.aria-pressed]="loose()"
          (click)="loose.set(!loose())"
        >
          Not attached
        </button>
        <button
          type="button"
          class="h-7 shrink-0 rounded-md border px-2 text-xs transition-colors"
          [class]="
            archived()
              ? 'border-border-strong bg-accent text-foreground'
              : 'border-dashed text-muted-foreground hover:text-foreground'
          "
          [attr.aria-pressed]="archived()"
          (click)="archived.set(!archived())"
        >
          Archived
        </button>
        @if (projectOptions().length) {
          <app-picker
            variant="chip"
            label="Project"
            [searchable]="projectOptions().length > 8"
            [clearable]="true"
            [options]="projectOptions()"
            [value]="projectId() ? [projectId()!] : []"
            (valueChange)="projectId.set($event[0] ?? null)"
          />
        }
        @if (hasFilters()) {
          <button
            hlmBtn
            variant="ghost"
            size="sm"
            class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs"
            (click)="clear()"
          >
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
      <label class="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 text-xs">
        Sort
        <select
          class="border-input bg-background text-foreground h-7 rounded-md border px-1.5 text-xs"
          aria-label="Sort documents"
          [value]="sort()"
          (change)="setSort($any($event.target).value)"
        >
          @for (s of sorts; track s) {
            <option [value]="s">{{ sortLabel[s] }}</option>
          }
        </select>
      </label>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      @if (error()) {
        <app-empty-state
          [icon]="fileIcon"
          title="Could not load documents"
          [description]="error()!"
        >
          <button hlmBtn size="sm" variant="outline" (click)="reload()">Try again</button>
        </app-empty-state>
      } @else if (!loaded()) {
        <p class="text-muted-foreground p-8 text-center text-sm" role="status">Loading…</p>
      } @else if (rows().length === 0) {
        @if (hasFilters()) {
          <app-empty-state
            [icon]="searchIcon"
            title="No document matches"
            description="Try other words, or clear the filters."
          >
            <button hlmBtn size="sm" variant="outline" (click)="clear()">Clear filters</button>
          </app-empty-state>
        } @else {
          <app-empty-state
            [icon]="fileIcon"
            title="No documents yet"
            description="Write the spec, the plan or the notes that do not belong in a repository. Paste Markdown to start, then attach the document to the project, workstream or issue it explains."
          >
            @if (canCreate()) {
              <button hlmBtn size="sm" (click)="create()">
                <svg [lucideIcon]="newIcon" [size]="14"></svg>New document
              </button>
            }
          </app-empty-state>
        }
      } @else {
        <ul aria-label="Documents">
          @for (d of rows(); track d.id) {
            <li><app-document-row [doc]="d" /></li>
          }
        </ul>
        @if (hasMore()) {
          <div class="flex justify-center p-4">
            <button hlmBtn variant="outline" size="sm" [disabled]="loadingMore()" (click)="more()">
              {{ loadingMore() ? 'Loading…' : 'Load more' }}
            </button>
          </div>
        }
      }
    </div>
  `,
})
export class DocumentListPage {
  private readonly store = inject(TramaStore);
  private readonly documents = inject(Documents);
  private readonly notifier = inject(Notifier);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');

  /** `?focus=search` (from the command bar) puts the cursor in the search box. */
  readonly focus = input<string>();

  protected readonly newIcon = LucideFilePlus;
  protected readonly fileIcon = LucideFileText;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly sorts = SORTS;
  protected readonly sortLabel = SORT_LABEL;

  protected readonly search = signal('');
  protected readonly mine = signal(false);
  protected readonly loose = signal(false);
  protected readonly archived = signal(false);
  protected readonly projectId = signal<string | null>(null);
  protected readonly sort = signal<Sort>(
    oneOf(readJson<{ sort?: string }>(DISPLAY_KEY)?.sort, SORTS, 'updated'),
  );

  protected readonly rows = signal<DocumentSummary[]>([]);
  protected readonly loaded = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly hasMore = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);

  protected readonly canCreate = computed(() => this.store.can('member'));
  protected readonly hasFilters = computed(
    () =>
      !!this.search().trim() ||
      this.mine() ||
      this.loose() ||
      this.archived() ||
      !!this.projectId(),
  );
  protected readonly projectOptions = computed<PickOption[]>(() =>
    this.store.projects().map((p) => ({ value: p.id, label: p.name, kind: 'project' as const })),
  );

  private requestId = 0;

  constructor() {
    usePageShortcuts([
      { keys: 'c', label: 'New document', run: () => this.create(), when: () => this.canCreate() },
      {
        keys: 'f',
        label: 'Search documents',
        run: (e) => {
          e.preventDefault();
          this.searchBox()?.nativeElement.focus();
        },
      },
    ]);
    effect(() => {
      const box = this.searchBox();
      if (this.focus() === 'search' && box)
        untracked(() => queueMicrotask(() => box.nativeElement.focus()));
    });

    effect((onCleanup) => {
      const q = this.search().trim();
      this.mine();
      this.loose();
      this.archived();
      this.projectId();
      this.sort();
      this.documents.changes();
      this.store.slug();
      const timer = setTimeout(() => void untracked(() => this.fetch(false)), q ? 200 : 0);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private query(offset: number): DocumentsQuery {
    const me = this.store.me();
    return {
      q: this.search().trim() || undefined,
      projectId: this.projectId() ?? undefined,
      attached: this.loose() ? false : undefined,
      archived: this.archived() ? 'only' : undefined,
      authorId: this.mine() && me ? me.id : undefined,
      sort: this.search().trim() && this.sort() === 'updated' ? undefined : this.sort(),
      order: this.sort() === 'title' ? 'asc' : 'desc',
      limit: PAGE,
      offset,
    };
  }

  private async fetch(append: boolean): Promise<void> {
    if (!this.store.slug()) return;
    const id = ++this.requestId;
    try {
      const offset = append ? this.rows().length : 0;
      const page = await this.documents.list(this.query(offset));
      if (id !== this.requestId) return;
      this.rows.set(append ? [...this.rows(), ...page] : page);
      this.hasMore.set(page.length === PAGE);
      this.error.set(null);
    } catch (e) {
      if (id !== this.requestId) return;
      this.error.set(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      if (id === this.requestId) {
        this.loaded.set(true);
        this.loadingMore.set(false);
      }
    }
  }

  protected reload(): void {
    void this.fetch(false);
  }

  protected more(): void {
    this.loadingMore.set(true);
    void this.fetch(true);
  }

  protected setSort(v: string): void {
    const sort = oneOf(v, SORTS, 'updated');
    this.sort.set(sort);
    writeJson(DISPLAY_KEY, { sort });
  }

  protected clear(): void {
    this.search.set('');
    this.mine.set(false);
    this.loose.set(false);
    this.archived.set(false);
    this.projectId.set(null);
  }

  protected async create(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    try {
      const project = this.projectId();
      await this.documents.createAndOpen(project ? { projectId: project } : {});
    } catch (e) {
      this.notifier.error(e instanceof ApiError ? e.message : 'Could not create the document');
    } finally {
      this.creating.set(false);
    }
  }
}
