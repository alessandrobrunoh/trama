// "Context" tab of the project page: every artifact under the project and its issues as a
// collapsible tree or a flat list, each traced back to its owner, plus the markdown briefing for agents.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
  LucidePackage,
  LucidePlus,
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
  TramaStore,
  type Artifact,
  type ArtifactKind,
  type ArtifactTreeNode,
  type Project,
  type SubjectRef,
} from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { Markdown } from '../../shared/markdown';
import { ArtifactIcon } from '../../shared/artifact';
import { DocumentActions } from '../documents/document-attach';
import { ProjectArtifactDialog } from './project-artifact-dialog';
import {
  ProjectArtifactRow,
  resolveSubject,
  SUBJECT_ICON,
  SUBJECT_TONE,
  type SubjectView,
} from './project-artifact-row';

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
    ProjectArtifactDialog,
    DocumentActions,
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
            <app-document-actions variant="outline" [owner]="{ projectId: project().id }" />
            <button hlmBtn size="sm" (click)="openAdd()">
              <svg [lucideIcon]="plusIcon" [size]="14"></svg>Add artifact
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
          description="Documents and links attached to the project, along with the pull requests, builds and docs of its tasks, show up here."
        >
          @if (canEdit()) {
            <button hlmBtn size="sm" (click)="openAdd()">Add artifact</button>
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
            The briefing handed to agents: the project, its tasks and artifacts.
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
  private readonly store = inject(TramaStore);
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

  // ───────────── actions ─────────────

  protected indent(depth: number): number {
    return INDENT_BASE + depth * INDENT_STEP;
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
