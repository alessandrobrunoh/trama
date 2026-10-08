// "Context" tab of the project page: every artifact under the project (its own + workstreams + issues) as a
// collapsible tree or a flat list, each traced back to its owner, plus the markdown briefing for agents.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideChevronDown,
  LucideChevronRight,
  LucideCircleAlert,
  LucideCopy,
  LucideDynamicIcon,
  LucideFileText,
  LucideMessageCircleQuestion,
  LucidePackage,
  LucidePlus,
  LucideScale,
  LucideSearch,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import {
  ARTIFACT_KIND_META,
  Clipboard,
  NablaStore,
  type Artifact,
  type ArtifactKind,
  type ArtifactTreeNode,
  type Decision,
  type InputRequest,
  type Project,
  type SubjectRef,
} from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { Markdown } from '../../shared/markdown';
import { StatusIcon } from '../../shared/status';
import { ArtifactIcon } from '../../shared/artifact';
import { ProjectArtifactDialog } from './project-artifact-dialog';
import {
  ProjectArtifactRow,
  resolveSubject,
  SUBJECT_ICON,
  SUBJECT_TONE,
  type SubjectView,
} from './project-artifact-row';

/** Rows shown per "other context" list before the "more" hint. */
const OTHER_LIMIT = 6;
const INDENT_BASE = 16;
const INDENT_STEP = 20;

interface FilteredNode {
  key: string;
  path: SubjectRef[];
  arts: Artifact[];
  children: FilteredNode[];
  count: number;
}

type TreeRow =
  | {
      t: 'node';
      key: string;
      depth: number;
      view: SubjectView;
      count: number;
      collapsible: boolean;
      collapsed: boolean;
    }
  | {
      t: 'artifact';
      key: string;
      depth: number;
      artifact: Artifact;
      path: SubjectRef[];
      editable: boolean;
    }
  | { t: 'hint'; key: string; depth: number };

@Component({
  selector: 'app-project-context-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDialogImports,
    HlmInputImports,
    HlmSkeleton,
    HlmSwitchImports,
    LucideDynamicIcon,
    ArtifactIcon,
    EmptyState,
    Markdown,
    StatusIcon,
    ProjectArtifactDialog,
    ProjectArtifactRow,
  ],
  host: { class: 'block' },
  template: `
    @if (storeStatus() === 'error' && total() === 0) {
      <app-empty-state
        [icon]="alertIcon"
        title="Could not load the project context"
        description="The workspace data failed to load. Check your connection and try again."
      >
        <button hlmBtn size="sm" variant="outline" (click)="retry()">Retry</button>
      </app-empty-state>
    } @else if (storeStatus() !== 'ready' && total() === 0) {
      <div
        class="flex flex-col gap-2 px-4 py-5 sm:px-6"
        aria-busy="true"
        aria-label="Loading context"
      >
        <div hlmSkeleton class="h-8 w-full max-w-md"></div>
        <div hlmSkeleton class="h-10"></div>
        <div hlmSkeleton class="h-10"></div>
        <div hlmSkeleton class="h-10"></div>
      </div>
    } @else {
      <!-- toolbar -->
      <div class="flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
        <div class="relative min-w-40 flex-1 sm:max-w-xs">
          <svg
            [lucideIcon]="searchIcon"
            [size]="14"
            class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          ></svg>
          <input
            hlmInput
            type="search"
            autocomplete="off"
            class="w-full pl-8"
            placeholder="Search the context…"
            aria-label="Search artifacts"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>
        <label class="text-muted-foreground flex items-center gap-2 text-xs">
          <hlm-switch
            [checked]="flat()"
            (checkedChange)="flat.set($event)"
            aria-label="Flat list"
          />
          Flat list
        </label>
        <span class="ml-auto flex flex-wrap items-center gap-2">
          <button hlmBtn size="sm" variant="outline" [disabled]="mdBusy()" (click)="copyContext()">
            <svg [lucideIcon]="copyIcon" [size]="14"></svg>Copy context
          </button>
          <button hlmBtn size="sm" variant="ghost" [disabled]="mdBusy()" (click)="openMarkdown()">
            <svg [lucideIcon]="fileIcon" [size]="14"></svg>Open as markdown
          </button>
          @if (canEdit()) {
            <button hlmBtn size="sm" (click)="openAdd()">
              <svg [lucideIcon]="plusIcon" [size]="14"></svg>Add document / link
            </button>
          }
        </span>
      </div>

      <!-- counts + kind filter -->
      <div class="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 sm:px-6">
        <span class="text-muted-foreground mr-1 text-xs tabular-nums">
          {{ shown() }}{{ filtering() ? ' of ' + total() : '' }} artifact{{
            total() === 1 ? '' : 's'
          }}
        </span>
        @for (k of kindCounts(); track k.kind) {
          <button
            hlmBtn
            size="sm"
            class="h-7 gap-1.5 px-2 text-xs font-normal"
            [variant]="kinds().has(k.kind) ? 'secondary' : 'outline'"
            [attr.aria-pressed]="kinds().has(k.kind)"
            (click)="toggleKind(k.kind)"
          >
            <app-artifact-icon [kind]="k.kind" [size]="12" />{{ k.label }}
            <span class="text-muted-foreground tabular-nums">{{ k.count }}</span>
          </button>
        }
        @if (filtering()) {
          <button
            hlmBtn
            size="sm"
            variant="ghost"
            class="h-7 gap-1 px-2 text-xs"
            (click)="clearFilters()"
          >
            <svg [lucideIcon]="clearIcon" [size]="12"></svg>Clear filters
          </button>
        }
      </div>

      <!-- tree / flat list -->
      @if (total() === 0) {
        <app-empty-state
          [icon]="pkgIcon"
          title="No context yet"
          description="Documents and links attached to the project, and the pull requests, builds and docs of its workstreams and issues, all show up here."
        >
          @if (canEdit()) {
            <button hlmBtn size="sm" (click)="openAdd()">Add document / link</button>
          }
        </app-empty-state>
      } @else if (shown() === 0) {
        <app-empty-state
          [icon]="searchIcon"
          title="Nothing matches"
          description="No artifact matches the current search and filters."
        >
          <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
        </app-empty-state>
      } @else if (flat()) {
        @for (r of flatRows(); track r.artifact.id) {
          <app-project-artifact-row
            [artifact]="r.artifact"
            [path]="r.path"
            origin="path"
            [editable]="canEdit() && r.path.length === 1"
            (edit)="openEdit($event)"
          />
        }
      } @else {
        @for (row of treeRows(); track row.key) {
          @switch (row.t) {
            @case ('node') {
              <div
                class="bg-muted/40 flex min-h-8 items-center gap-1.5 border-b pr-4 sm:pr-6"
                [style.padding-left.px]="indent(row.depth)"
              >
                @if (row.collapsible) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md"
                    [attr.aria-expanded]="!row.collapsed"
                    [attr.aria-label]="(row.collapsed ? 'Expand ' : 'Collapse ') + row.view.label"
                    (click)="toggleNode(row.key)"
                  >
                    <svg [lucideIcon]="row.collapsed ? chevRight : chevDown" [size]="14"></svg>
                  </button>
                } @else {
                  <span class="size-6 shrink-0"></span>
                }
                <svg
                  [lucideIcon]="subjectIcon[row.view.type]"
                  [size]="14"
                  class="shrink-0"
                  [class]="subjectTone[row.view.type]"
                ></svg>
                <a
                  [routerLink]="row.view.link"
                  class="flex min-w-0 items-center gap-2 text-xs font-medium hover:underline"
                >
                  @if (row.view.type === 'project') {
                    <span class="truncate">{{ row.view.label }}</span>
                    <span class="text-muted-foreground font-normal max-sm:hidden"
                      >documents and links</span
                    >
                  } @else {
                    <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{
                      row.view.label
                    }}</span>
                    <span class="truncate">{{ row.view.title }}</span>
                  }
                </a>
                <span class="text-muted-foreground ml-auto pl-2 text-xs tabular-nums">{{
                  row.count
                }}</span>
              </div>
            }
            @case ('artifact') {
              <app-project-artifact-row
                [artifact]="row.artifact"
                [path]="row.path"
                origin="owner"
                [indent]="indent(row.depth)"
                [editable]="row.editable"
                (edit)="openEdit($event)"
              />
            }
            @case ('hint') {
              <div
                class="text-muted-foreground flex min-h-9 items-center gap-2 border-b pr-4 text-xs sm:pr-6"
                [style.padding-left.px]="indent(row.depth)"
              >
                Nothing attached to the project itself yet.
                @if (canEdit()) {
                  <button type="button" class="text-primary hover:underline" (click)="openAdd()">
                    Add a document or link
                  </button>
                }
              </div>
            }
          }
        }
      }

      <!-- other context: open decisions + open questions from the workstreams -->
      <section class="px-4 py-5 sm:px-6" aria-labelledby="pc-other">
        <h2 id="pc-other" class="mb-1 text-sm font-medium">Other context</h2>
        <p class="text-muted-foreground mb-3 text-xs">
          Decisions in play and questions waiting for an answer in this project’s workstreams.
        </p>
        @if (ctxState() === 'error' && !ctx()) {
          <div
            class="border-border flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-xs"
          >
            <svg [lucideIcon]="alertIcon" [size]="14" class="text-status-blocked shrink-0"></svg>
            <span class="text-muted-foreground">Could not load decisions and questions.</span>
            <button
              hlmBtn
              size="sm"
              variant="outline"
              class="ml-auto h-7"
              (click)="reloadContext()"
            >
              Retry
            </button>
          </div>
        } @else if (!ctx()) {
          <div
            class="flex flex-col gap-2"
            aria-busy="true"
            aria-label="Loading decisions and questions"
          >
            <div hlmSkeleton class="h-9"></div>
            <div hlmSkeleton class="h-9"></div>
          </div>
        } @else if (decisions().length === 0 && requests().length === 0) {
          <p class="text-muted-foreground text-xs">No open decisions or questions.</p>
        } @else {
          <div class="grid gap-4 lg:grid-cols-2">
            @if (decisions().length) {
              <div class="min-w-0">
                <h3
                  class="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium"
                >
                  <svg [lucideIcon]="scaleIcon" [size]="13" class="text-entity-decision"></svg>
                  Decisions
                  <span class="font-normal tabular-nums">{{ decisions().length }}</span>
                </h3>
                <ul class="border-border overflow-hidden rounded-lg border">
                  @for (d of decisionsShown(); track d.id) {
                    <li
                      class="hover:bg-hover relative flex min-h-9 items-center gap-2 border-b px-3 text-[13px] last:border-b-0"
                    >
                      <a
                        class="absolute inset-0"
                        [routerLink]="['/', slug(), 'decisions', d.key]"
                        [attr.aria-label]="d.key + ' ' + d.title"
                      ></a>
                      <app-status-icon [status]="d.status" entity="other" />
                      <span class="text-muted-foreground shrink-0 font-mono text-xs">{{
                        d.key
                      }}</span>
                      <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
                      @if (originOf(d.originWorkstreamId); as o) {
                        <a
                          [routerLink]="o.link"
                          class="text-muted-foreground hover:text-foreground relative shrink-0 font-mono text-[11px] hover:underline"
                          >{{ o.label }}</a
                        >
                      }
                    </li>
                  }
                </ul>
                @if (decisions().length > decisionsShown().length) {
                  <p class="text-muted-foreground mt-1 text-xs">
                    +{{ decisions().length - decisionsShown().length }} more
                  </p>
                }
              </div>
            }
            @if (requests().length) {
              <div class="min-w-0">
                <h3
                  class="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium"
                >
                  <svg
                    [lucideIcon]="questionIcon"
                    [size]="13"
                    class="text-status-needs-input"
                  ></svg>
                  Open questions
                  <span class="font-normal tabular-nums">{{ requests().length }}</span>
                </h3>
                <ul class="border-border overflow-hidden rounded-lg border">
                  @for (q of requestsShown(); track q.id) {
                    <li
                      class="hover:bg-hover relative flex min-h-9 items-center gap-2 border-b px-3 text-[13px] last:border-b-0"
                    >
                      @if (originOf(q.workstreamId); as o) {
                        <a
                          class="absolute inset-0"
                          [routerLink]="o.link"
                          [attr.aria-label]="'Open ' + o.label + ': ' + q.question"
                        ></a>
                        <span class="text-muted-foreground shrink-0 font-mono text-xs">{{
                          o.label
                        }}</span>
                      }
                      <span class="min-w-0 flex-1 truncate">{{ q.question }}</span>
                    </li>
                  }
                </ul>
                @if (requests().length > requestsShown().length) {
                  <p class="text-muted-foreground mt-1 text-xs">
                    +{{ requests().length - requestsShown().length }} more
                  </p>
                }
              </div>
            }
          </div>
        }
      </section>
    }

    <app-project-artifact-dialog [(open)]="dialogOpen" [target]="target()" [artifact]="editing()" />

    <hlm-dialog [state]="mdOpen() ? 'open' : 'closed'" (closed)="mdOpen.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="flex max-h-[92svh] flex-col sm:max-w-3xl"
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Project context</h2>
          <p hlmDialogDescription>
            The briefing handed to agents: the project, its workstreams, issues, artifacts and
            decisions.
          </p>
        </hlm-dialog-header>
        <div class="flex items-center gap-1.5">
          <button
            hlmBtn
            size="sm"
            [variant]="mdView() === 'preview' ? 'secondary' : 'outline'"
            (click)="mdView.set('preview')"
          >
            Preview
          </button>
          <button
            hlmBtn
            size="sm"
            [variant]="mdView() === 'raw' ? 'secondary' : 'outline'"
            (click)="mdView.set('raw')"
          >
            Markdown
          </button>
        </div>
        <div class="border-border min-h-40 flex-1 overflow-auto rounded-md border p-3">
          @if (markdown(); as md) {
            @if (mdView() === 'preview') {
              <app-markdown [source]="md" />
            } @else {
              <pre class="font-mono text-xs whitespace-pre-wrap">{{ md }}</pre>
            }
          } @else {
            <div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading briefing">
              <div hlmSkeleton class="h-5 w-1/2"></div>
              <div hlmSkeleton class="h-4"></div>
              <div hlmSkeleton class="h-4"></div>
              <div hlmSkeleton class="h-4 w-3/4"></div>
            </div>
          }
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Close</button>
          <button hlmBtn type="button" [disabled]="!markdown()" (click)="copyShown()">
            <svg [lucideIcon]="copyIcon" [size]="14"></svg>Copy
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ProjectContextTab {
  private readonly store = inject(NablaStore);
  private readonly clipboard = inject(Clipboard);

  readonly project = input.required<Project>();

  protected readonly alertIcon = LucideCircleAlert;
  protected readonly searchIcon = LucideSearch;
  protected readonly clearIcon = LucideX;
  protected readonly copyIcon = LucideCopy;
  protected readonly fileIcon = LucideFileText;
  protected readonly plusIcon = LucidePlus;
  protected readonly pkgIcon = LucidePackage;
  protected readonly chevRight = LucideChevronRight;
  protected readonly chevDown = LucideChevronDown;
  protected readonly scaleIcon = LucideScale;
  protected readonly questionIcon = LucideMessageCircleQuestion;
  protected readonly subjectIcon = SUBJECT_ICON;
  protected readonly subjectTone = SUBJECT_TONE;

  // view state
  protected readonly query = signal('');
  protected readonly kinds = signal<ReadonlySet<ArtifactKind>>(new Set());
  protected readonly flat = signal(false);
  private readonly collapsedKeys = signal<ReadonlySet<string>>(new Set());

  // dialogs
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<Artifact | undefined>(undefined);
  protected readonly mdOpen = signal(false);
  protected readonly mdView = signal<'preview' | 'raw'>('preview');
  protected readonly markdown = signal<string | undefined>(undefined);
  protected readonly mdBusy = signal(false);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly storeStatus = this.store.status;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly target = computed(() => ({ type: 'project' as const, id: this.project().id }));

  // ───────────── data ─────────────

  private readonly root = computed<ArtifactTreeNode | undefined>(() =>
    this.store.projectArtifactTree().get(this.project().id),
  );
  private readonly allArtifacts = computed(
    () => this.store.projectArtifacts().get(this.project().id) ?? [],
  );
  protected readonly total = computed(() => this.allArtifacts().length);

  protected readonly kindCounts = computed(() => {
    const counts = new Map<ArtifactKind, number>();
    for (const { artifact } of this.allArtifacts())
      counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
    return [...counts]
      .map(([kind, count]) => ({ kind, count, label: ARTIFACT_KIND_META[kind].label }))
      .sort((a, b) => ARTIFACT_KIND_META[a.kind].order - ARTIFACT_KIND_META[b.kind].order);
  });

  protected readonly filtering = computed(
    () => this.query().trim() !== '' || this.kinds().size > 0,
  );

  private readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    const kinds = this.kinds();
    return (a: Artifact): boolean => {
      if (kinds.size && !kinds.has(a.kind)) return false;
      if (!q) return true;
      const hay = [
        a.title,
        a.externalId,
        a.description,
        a.url,
        ARTIFACT_KIND_META[a.kind].label,
        a.provider,
        a.environment,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    };
  });

  protected readonly flatRows = computed(() =>
    this.allArtifacts()
      .filter((r) => this.matches()(r.artifact))
      .sort((a, b) => (a.artifact.updatedAt < b.artifact.updatedAt ? 1 : -1)),
  );

  private readonly filteredTree = computed<FilteredNode | undefined>(() => {
    const root = this.root();
    if (!root) return undefined;
    const match = this.matches();
    const build = (
      node: ArtifactTreeNode,
      parentKey: string,
      parentPath: SubjectRef[],
    ): FilteredNode => {
      const key = parentKey ? `${parentKey}/${node.subject.id}` : node.subject.id;
      const path = [...parentPath, node.subject];
      const arts = node.artifacts.filter(match);
      const children = node.children.map((c) => build(c, key, path));
      return {
        key,
        path,
        arts,
        children,
        count: arts.length + children.reduce((n, c) => n + c.count, 0),
      };
    };
    return build(root, '', []);
  });

  /** Artifacts shown in the current view (flat or tree). */
  protected readonly shown = computed(() =>
    this.flat() ? this.flatRows().length : (this.filteredTree()?.count ?? 0),
  );

  protected readonly treeRows = computed<TreeRow[]>(() => {
    const tree = this.filteredTree();
    if (!tree) return [];
    const collapsed = this.filtering() ? new Set<string>() : this.collapsedKeys();
    const rows: TreeRow[] = [];
    const emit = (n: FilteredNode, depth: number): void => {
      const ref = n.path[n.path.length - 1];
      const view = resolveSubject(this.store, ref);
      if (!view) return;
      const isRoot = depth === 0;
      const isCollapsed = collapsed.has(n.key);
      rows.push({
        t: 'node',
        key: `n:${n.key}`,
        depth,
        view,
        count: n.count,
        collapsible: !isRoot,
        collapsed: isCollapsed,
      });
      if (isCollapsed) return;
      if (isRoot && n.arts.length === 0 && !this.filtering())
        rows.push({ t: 'hint', key: `h:${n.key}`, depth: depth + 1 });
      for (const artifact of n.arts) {
        rows.push({
          t: 'artifact',
          key: `a:${n.key}:${artifact.id}`,
          depth: depth + 1,
          artifact,
          path: n.path,
          editable: isRoot && this.canEdit(),
        });
      }
      for (const c of n.children) if (c.count > 0) emit(c, depth + 1);
    };
    emit(tree, 0);
    return rows;
  });

  // other context (from the server's authoritative /context)
  protected readonly ctx = computed(() => this.store.projectContextOf(this.project().id)());
  protected readonly ctxState = computed(() => this.store.projectContextState(this.project().id)());
  protected readonly decisions = computed<Decision[]>(() =>
    (this.ctx()?.decisions ?? []).filter(
      (d) => d.status === 'proposed' || d.status === 'accepted' || d.status === 'draft',
    ),
  );
  protected readonly decisionsShown = computed(() => this.decisions().slice(0, OTHER_LIMIT));
  protected readonly requests = computed<InputRequest[]>(() =>
    (this.ctx()?.inputRequests ?? []).filter((q) => q.state === 'open'),
  );
  protected readonly requestsShown = computed(() => this.requests().slice(0, OTHER_LIMIT));

  constructor() {
    effect(() => {
      const id = this.project().id;
      void this.store.projectContext(id);
    });
  }

  // ───────────── actions ─────────────

  protected indent(depth: number): number {
    return INDENT_BASE + depth * INDENT_STEP;
  }

  protected originOf(workstreamId: string | undefined): SubjectView | null {
    return workstreamId
      ? resolveSubject(this.store, { type: 'workstream', id: workstreamId })
      : null;
  }

  protected toggleKind(kind: ArtifactKind): void {
    this.kinds.update((s) => {
      const next = new Set(s);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });
  }

  protected clearFilters(): void {
    this.query.set('');
    this.kinds.set(new Set());
  }

  protected toggleNode(key: string): void {
    // rows carry `n:<key>`; collapsed state is stored by the bare node key
    const bare = key.startsWith('n:') ? key.slice(2) : key;
    this.collapsedKeys.update((s) => {
      const next = new Set(s);
      if (!next.delete(bare)) next.add(bare);
      return next;
    });
  }

  protected openAdd(): void {
    this.editing.set(undefined);
    this.dialogOpen.set(true);
  }

  protected openEdit(a: Artifact): void {
    this.editing.set(a);
    this.dialogOpen.set(true);
  }

  protected retry(): void {
    void this.store.refetch();
  }

  protected reloadContext(): void {
    void this.store.projectContext(this.project().id, { force: true });
  }

  protected async copyContext(): Promise<void> {
    const md = await this.fetchMarkdown();
    if (md) await this.clipboard.copy(md, 'Project context copied');
  }

  protected async openMarkdown(): Promise<void> {
    this.markdown.set(undefined);
    this.mdView.set('preview');
    this.mdOpen.set(true);
    const md = await this.fetchMarkdown();
    if (md) this.markdown.set(md);
    else this.mdOpen.set(false);
  }

  protected async copyShown(): Promise<void> {
    const md = this.markdown();
    if (md) await this.clipboard.copy(md, 'Project context copied');
  }

  private async fetchMarkdown(): Promise<string | undefined> {
    if (this.mdBusy()) return undefined;
    this.mdBusy.set(true);
    try {
      return await this.store.projectContextMarkdown(this.project().id);
    } finally {
      this.mdBusy.set(false);
    }
  }
}
