import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  LucideDynamicIcon,
  LucideGitBranch,
  LucideMaximize,
  LucideMinus,
  LucidePlus,
  LucideWorkflow,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  TramaStore,
  statusVar,
  usePageShortcuts,
  type ArtifactState,
  type CiState,
} from '../../core';
import { AvatarStack } from '../../shared/actor-avatar';
import { ArtifactIcon } from '../../shared/artifact';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon, type AnyStatus } from '../../shared/status';
import { GraphNodeDetail, type DetailLink } from './graph-node-detail';
import { layoutGraph, routePath, type PlacedNode } from './graph-layout';
import type { ExecutionGraphData, GraphEdge, GraphNode } from './graph-model';

const SIZE = {
  workstream: { w: 248, h: 58 },
  artifact: { w: 200, h: 28 },
} as const;
const MIN_K = 0.12;
const MAX_K = 2.5;

/** Token colour for the left accent of a node. */
const ARTIFACT_ACCENT: Record<ArtifactState, string> = {
  draft: 'draft',
  open: 'working',
  merged: 'in-review',
  closed: 'canceled',
  pending: 'pending',
  running: 'working',
  succeeded: 'shipped',
  failed: 'blocked',
  healthy: 'healthy',
  degraded: 'degraded',
  published: 'shipped',
};

interface PlacedView {
  node: GraphNode;
  p: PlacedNode;
  accent: string;
  status: AnyStatus;
}
interface EdgeView {
  edge: GraphEdge;
  d: string;
}

let uidCounter = 0;

/**
 * Execution graph canvas: workstreams -> executions (incl. subthreads) -> artifacts, with dashed
 * dependency edges and performer badges. Layered left-to-right layout (see graph-layout.ts), pan by
 * dragging, zoom with wheel / pinch / buttons, fit-to-screen, hover highlights a node's lineage and
 * a click opens a side sheet with details. Edges are SVG, nodes are HTML boxes inside one transformed
 * layer (so they can use the shared status / avatar components and stay token-themed in light & dark).
 *
 *   <app-execution-graph [graph]="graph()" />
 *
 * Inputs: `graph` (ExecutionGraphData, required), `selectedId` (two-way, node id or null),
 * `showSheet` (default true), `showLegend` (default true), `emptyText`. Output: `nodeSelected`.
 */
@Component({
  selector: 'app-execution-graph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    LucideDynamicIcon,
    HlmButtonImports,
    HlmTooltip,
    StatusIcon,
    KeyChip,
    PriorityIcon,
    AvatarStack,
    ArtifactIcon,
    EmptyState,
    GraphNodeDetail,
  ],
  host: { class: 'relative block h-full min-h-72 w-full' },
  template: `
    @if (!graph().nodes.length) {
      <app-empty-state [icon]="emptyIcon" title="Nothing to show" [description]="emptyText()" />
    } @else {
      <div
        #viewport
        class="bg-background absolute inset-0 touch-none overflow-hidden select-none"
        [style.background-image]="'radial-gradient(var(--border-strong) 1px, transparent 1px)'"
        [style.background-size]="(20 * k()).toFixed(2) + 'px ' + (20 * k()).toFixed(2) + 'px'"
        [style.background-position]="tx().toFixed(1) + 'px ' + ty().toFixed(1) + 'px'"
        [class.cursor-grabbing]="panning()"
        [class.cursor-grab]="!panning()"
        (click)="onCanvasClick($event)"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onUp($event)"
        (dblclick)="onDblClick($event)"
      >
        <div
          class="absolute top-0 left-0 origin-top-left"
          [style.width.px]="layout().width"
          [style.height.px]="layout().height"
          [style.transform]="transform()"
        >
          <svg
            class="pointer-events-none absolute top-0 left-0 overflow-visible"
            [attr.width]="layout().width"
            [attr.height]="layout().height"
            aria-hidden="true"
          >
            <defs>
              <marker [id]="uid + '-a'" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M1 1.5 L8 4.5 L1 7.5 Z" class="fill-muted-foreground/60" />
              </marker>
              <marker [id]="uid + '-b'" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M1 1.5 L8 4.5 L1 7.5 Z" class="fill-foreground/75" />
              </marker>
              <marker [id]="uid + '-c'" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M1 1.5 L8 4.5 L1 7.5 Z" class="fill-primary" />
              </marker>
            </defs>
            @for (e of edgeViews(); track e.edge.id) {
              <path
                [attr.d]="e.d"
                fill="none"
                [attr.stroke-dasharray]="e.edge.kind === 'depends_on' ? '5 4' : null"
                [attr.marker-end]="e.edge.kind === 'depends_on' ? markerFor(e.edge) : null"
                [class]="edgeClass(e.edge)"
              />
            }
          </svg>

          @for (v of placed(); track v.node.id) {
            <div
              role="button"
              tabindex="0"
              data-graph-node
              class="bg-card absolute overflow-hidden rounded-md border border-border-strong text-left shadow-[var(--shadow-panel)] transition-[opacity,border-color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              [class.border-dashed]="v.node.external"
              [class.opacity-60]="v.node.external && !isLit(v.node.id) && !dimmed(v.node.id)"
              [class.opacity-40]="dimmed(v.node.id)"
              [class.ring-2]="selectedId() === v.node.id"
              [class.ring-primary]="selectedId() === v.node.id"
              [class.border-foreground/40]="hovered() === v.node.id"
              [class.cursor-pointer]="true"
              [style.left.px]="v.p.x"
              [style.top.px]="v.p.y"
              [style.width.px]="v.p.w"
              [style.height.px]="v.p.h"
              [style.box-shadow]="'inset 3px 0 0 ' + v.accent"
              [attr.aria-label]="label(v.node)"
              (pointerenter)="hovered.set(v.node.id)"
              (pointerleave)="hovered.set(null)"
              (click)="onNodeClick(v.node)"
              (keydown.enter)="select(v.node.id)"
              (keydown.space)="select(v.node.id); $event.preventDefault()"
            >
              @switch (v.node.kind) {
                @case ('workstream') {
                  @let w = $any(v.node.entity);
                  <div class="flex h-full flex-col justify-center gap-0.5 pr-2.5 pl-3.5">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <app-status-icon entity="workstream" [status]="w.status" [size]="14" />
                      <app-key-chip [value]="w.key" />
                      @if (w.priority !== 'none') {
                        <app-priority-icon [priority]="w.priority" />
                      }
                      @if (isBlocked(v.node.id)) {
                        <span class="bg-status-blocked/10 text-status-blocked rounded px-1.5 py-0.5 text-[10px] font-medium">Blocked</span>
                      }
                      <span class="ml-auto flex shrink-0 items-center">
                        <app-avatar-stack [actors]="teamActors(w.ownerTeamId, w.participatingTeamIds)" [max]="3" [size]="16" />
                      </span>
                    </div>
                    <div class="truncate text-xs font-medium">{{ w.title }}</div>
                  </div>
                  @if (w.acceptanceCriteria.length) {
                    <div class="bg-border absolute right-0 bottom-0 left-0 h-0.5">
                      <div class="h-full" [style.width.%]="criteria(w)" [style.background]="v.accent"></div>
                    </div>
                  }
                }
                @case ('artifact') {
                  @let a = $any(v.node.entity);
                  <div class="flex h-full items-center gap-1.5 pr-2 pl-3.5">
                    <app-artifact-icon [kind]="a.kind" [state]="a.state" [size]="13" />
                    <span class="truncate text-xs">{{ a.title }}</span>
                    @if (a.ci) {
                      <span class="ml-auto shrink-0"><app-status-icon [status]="$any(a.ci)" [size]="12" /></span>
                    } @else if (a.environment) {
                      <span class="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">{{ a.environment }}</span>
                    }
                  </div>
                }
              }
            </div>
          }
        </div>

        <!-- controls -->
        <div
          class="bg-popover/95 absolute top-3 left-3 flex items-center gap-0.5 rounded-lg border border-border-strong p-0.5 shadow-[var(--shadow-panel)] backdrop-blur"
          (pointerdown)="$event.stopPropagation()"
          (dblclick)="$event.stopPropagation()"
        >
          <button hlmBtn variant="ghost" size="icon-sm" type="button" hlmTooltip="Zoom out" position="bottom" aria-label="Zoom out" (click)="zoomBy(1 / 1.25)">
            <svg [lucideIcon]="minus" [size]="14"></svg>
          </button>
          <span class="text-muted-foreground w-10 text-center text-xs tabular-nums">{{ zoomPct() }}%</span>
          <button hlmBtn variant="ghost" size="icon-sm" type="button" hlmTooltip="Zoom in" position="bottom" aria-label="Zoom in" (click)="zoomBy(1.25)">
            <svg [lucideIcon]="plus" [size]="14"></svg>
          </button>
          <span class="bg-border mx-0.5 h-4 w-px"></span>
          <button hlmBtn variant="ghost" size="icon-sm" type="button" hlmTooltip="Fit to screen" position="bottom" aria-label="Fit to screen" (click)="fit()">
            <svg [lucideIcon]="maximize" [size]="14"></svg>
          </button>
        </div>

        @if (showLegend()) {
          <div
            class="bg-popover/95 text-muted-foreground absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-strong px-2.5 py-1.5 text-[11px] backdrop-blur max-sm:hidden"
            (pointerdown)="$event.stopPropagation()"
          >
            <span class="flex items-center gap-1.5">
              <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" class="stroke-muted-foreground/60" stroke-width="1.25" /></svg>
              contains
            </span>
            <span class="flex items-center gap-1.5">
              <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" class="stroke-foreground/70" stroke-width="1.5" stroke-dasharray="4 3" /></svg>
              A → B: B waits on A
            </span>
            <span class="flex items-center gap-1.5"><app-status-icon entity="workstream" status="working" [size]="12" /> workstream</span>
            <span class="flex items-center gap-1.5"><svg [lucideIcon]="branch" [size]="12"></svg> artifact</span>
          </div>
        }
      </div>

      @if (showSheet() && sheetOpen()) {
        @if (detail(); as d) {
          <aside
            class="bg-popover text-popover-foreground absolute inset-y-0 right-0 z-10 flex w-full flex-col border-l border-border-strong shadow-[var(--shadow-menu)] sm:w-[22rem]"
            aria-label="Node details"
            (pointerdown)="$event.stopPropagation()"
            (dblclick)="$event.stopPropagation()"
            (wheel)="$event.stopPropagation()"
          >
            <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
              <span class="text-muted-foreground text-xs font-medium">{{ d.node.kind === 'workstream' ? 'Workstream' : 'Artifact' }}</span>
              <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Close details" hlmTooltip="Close (Esc)" (click)="select(null)">
                <svg [lucideIcon]="closeIcon" [size]="15"></svg>
              </button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <app-graph-node-detail [node]="d.node" [blockedBy]="d.blockedBy" [blocks]="d.blocks" (focusNode)="focusNode($event)" />
            </div>
          </aside>
        }
      }
    }
  `,
})
export class ExecutionGraph {
  private readonly store = inject(TramaStore);
  private readonly destroyRef = inject(DestroyRef);

  readonly graph = input.required<ExecutionGraphData>();
  readonly selectedId = model<string | null>(null);
  readonly showSheet = input(true);
  readonly showLegend = input(true);
  readonly emptyText = input('Adjust the filters, or create a workstream first.');
  readonly nodeSelected = output<GraphNode | null>();

  protected readonly uid = `eg${++uidCounter}`;
  protected readonly emptyIcon = LucideWorkflow;
  protected readonly minus = LucideMinus;
  protected readonly plus = LucidePlus;
  protected readonly maximize = LucideMaximize;
  protected readonly branch = LucideGitBranch;
  protected readonly closeIcon = LucideX;

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');

  // ── view state ──
  protected readonly tx = signal(0);
  protected readonly ty = signal(0);
  protected readonly k = signal(1);
  protected readonly panning = signal(false);
  protected readonly hovered = signal<string | null>(null);
  protected readonly sheetOpen = signal(false);
  private readonly sheetId = signal<string | null>(null);
  private readonly size = signal({ w: 0, h: 0 });

  protected readonly transform = computed(
    () => `translate(${this.tx().toFixed(2)}px, ${this.ty().toFixed(2)}px) scale(${this.k().toFixed(4)})`,
  );
  protected readonly zoomPct = computed(() => Math.round(this.k() * 100));

  // ── layout ──
  protected readonly layout = computed(() => {
    const g = this.graph();
    return layoutGraph(
      g.nodes.map((n) => ({ id: n.id, ...SIZE[n.kind] })),
      g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    );
  });
  protected readonly placed = computed<PlacedView[]>(() => {
    const lay = this.layout().nodes;
    const out: PlacedView[] = [];
    for (const node of this.graph().nodes) {
      const p = lay.get(node.id);
      if (!p) continue;
      const status = this.statusOf(node);
      out.push({ node, p, status, accent: this.accentOf(node, status) });
    }
    return out;
  });
  protected readonly edgeViews = computed<EdgeView[]>(() => {
    const routes = this.layout().routes;
    const out: EdgeView[] = [];
    for (const edge of this.graph().edges) {
      const r = routes.get(edge.id);
      if (r) out.push({ edge, d: routePath(r) });
    }
    return out;
  });
  private readonly blockedIds = computed(() => {
    const blocked = new Set<string>();
    for (const edge of this.graph().edges) {
      if (edge.kind === 'depends_on' && edge.blocking) blocked.add(edge.target);
    }
    return blocked;
  });
  /** Changes only when the node / edge set changes (not on status updates). */
  private readonly structureKey = computed(
    () => this.graph().nodes.map((n) => n.id).join('|') + '#' + this.graph().edges.map((e) => e.id).join('|'),
  );

  // ── lineage highlight ──
  private readonly adjacency = computed(() => {
    const out = new Map<string, string[]>();
    const inn = new Map<string, string[]>();
    for (const e of this.graph().edges) {
      (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
      (inn.get(e.target) ?? inn.set(e.target, []).get(e.target)!).push(e.source);
    }
    return { out, inn };
  });
  private readonly activeId = computed(() => this.hovered() ?? this.selectedId());
  private readonly lineage = computed<ReadonlySet<string> | null>(() => {
    const id = this.activeId();
    if (!id) return null;
    // the node and its direct neighbours only (a full lineage dims too much of a dense graph)
    const { out, inn } = this.adjacency();
    return new Set<string>([id, ...(out.get(id) ?? []), ...(inn.get(id) ?? [])]);
  });

  // ── detail sheet ──
  protected readonly detail = computed(() => {
    const id = this.sheetId();
    if (!id) return undefined;
    const g = this.graph();
    const node = g.nodes.find((n) => n.id === id);
    if (!node) return undefined;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const link = (nid: string): DetailLink | undefined => {
      const n = byId.get(nid);
      if (!n) return undefined;
      return { id: n.id, label: this.label(n, true), status: this.statusOf(n), mono: false };
    };
    const blockedBy = g.edges
      .filter((e) => e.kind === 'depends_on' && e.target === id)
      .map((e) => {
        const item = link(e.source);
        return item ? { ...item, blocking: e.blocking } : undefined;
      })
      .filter(Boolean) as DetailLink[];
    const blocks = g.edges.filter((e) => e.kind === 'depends_on' && e.source === id).map((e) => link(e.target)).filter(Boolean) as DetailLink[];
    return { node, blockedBy, blocks };
  });

  constructor() {
    afterNextRender(() => {
      const el = this.viewport()?.nativeElement;
      if (el) this.attachViewport(el);
    });
    // the viewport element appears/disappears with the graph being empty
    effect(() => {
      const el = this.viewport()?.nativeElement;
      if (el) untracked(() => this.attachViewport(el));
    });
    // re-fit whenever the structure changes (filters), but not on mere status updates
    let lastKey = '';
    effect(() => {
      const key = this.structureKey();
      const { w, h } = this.size();
      untracked(() => {
        if (!w || !h) return;
        if (key !== lastKey) {
          lastKey = key;
          this.fit(true);
        }
      });
    });
    effect(() => {
      // selection driven from outside (two-way binding) opens the sheet
      const id = this.selectedId();
      untracked(() => {
        if (id && this.showSheet()) {
          this.sheetId.set(id);
          this.sheetOpen.set(true);
        }
      });
    });
  }

  // ── viewport plumbing ──
  private attached: HTMLElement | null = null;
  private ro?: ResizeObserver;
  private attachViewport(el: HTMLElement): void {
    if (this.attached === el) return;
    this.ro?.disconnect();
    this.attached = el;
    el.addEventListener('wheel', this.onWheel, { passive: false });
    this.ro = new ResizeObserver(() => {
      this.size.set({ w: el.clientWidth, h: el.clientHeight });
    });
    this.ro.observe(el);
    this.size.set({ w: el.clientWidth, h: el.clientHeight });
    this.destroyRef.onDestroy(() => {
      this.ro?.disconnect();
      el.removeEventListener('wheel', this.onWheel);
    });
  }

  /** Fit the whole graph in the viewport. `initial` keeps text legible on big graphs (min zoom 0.5, top-left anchored). */
  fit(initial = false): void {
    const { w, h } = this.size();
    const lay = this.layout();
    if (!w || !h || !lay.width) return;
    const pad = 12;
    const fitK = Math.min((w - pad * 2) / lay.width, (h - pad * 2) / lay.height);
    let k = Math.min(1, fitK);
    if (initial) k = Math.max(k, Math.min(1, w < 640 ? 0.6 : 0.62));
    k = Math.max(MIN_K, k);
    this.k.set(k);
    const gw = lay.width * k;
    const gh = lay.height * k;
    this.tx.set(gw <= w ? (w - gw) / 2 : pad);
    this.ty.set(gh <= h ? (h - gh) / 2 : pad);
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const { w, h } = this.size();
    const px = cx ?? w / 2;
    const py = cy ?? h / 2;
    const k0 = this.k();
    const k1 = Math.min(MAX_K, Math.max(MIN_K, k0 * factor));
    if (k1 === k0) return;
    this.tx.set(px - (px - this.tx()) * (k1 / k0));
    this.ty.set(py - (py - this.ty()) * (k1 / k0));
    this.k.set(k1);
  }

  private readonly onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const el = this.attached;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX)) {
      // pinch (ctrl+wheel) and plain wheel both zoom around the cursor
      const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      this.zoomBy(Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - r.left, ev.clientY - r.top);
    } else {
      this.tx.update((x) => x - ev.deltaX);
    }
  };

  // pointer handling: one pointer pans, two pinch
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private startX = 0;
  private startY = 0;
  private moved = false;
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private suppressClick = false;

  protected onDown(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 1) {
      this.startX = ev.clientX;
      this.startY = ev.clientY;
      this.moved = false;
      this.suppressClick = false;
    } else if (this.pointers.size === 2) {
      this.pinch = this.pinchState();
      this.moved = true;
      this.suppressClick = true;
      this.panning.set(true);
    }
  }

  protected onMove(ev: PointerEvent): void {
    const prev = this.pointers.get(ev.pointerId);
    if (!prev) return;
    const cur = { x: ev.clientX, y: ev.clientY };
    this.pointers.set(ev.pointerId, cur);
    if (this.pointers.size === 2 && this.pinch) {
      const next = this.pinchState();
      const el = this.attached;
      const r = el?.getBoundingClientRect();
      if (r && next.dist > 0 && this.pinch.dist > 0) {
        this.zoomBy(next.dist / this.pinch.dist, next.mx - r.left, next.my - r.top);
        this.tx.update((x) => x + (next.mx - this.pinch!.mx));
        this.ty.update((y) => y + (next.my - this.pinch!.my));
      }
      this.pinch = next;
      return;
    }
    if (this.pointers.size !== 1) return;
    if (!this.moved) {
      if (Math.hypot(cur.x - this.startX, cur.y - this.startY) < 4) return;
      this.moved = true;
      this.suppressClick = true;
      this.panning.set(true);
      this.attached?.setPointerCapture(ev.pointerId);
    }
    this.tx.update((x) => x + (cur.x - prev.x));
    this.ty.update((y) => y + (cur.y - prev.y));
  }

  protected onUp(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.panning.set(false);
    else if (this.pointers.size === 1) {
      // continue panning with the remaining finger without a jump
      const only = [...this.pointers.values()][0];
      this.startX = only.x;
      this.startY = only.y;
    }
  }

  private pinchState(): { dist: number; mx: number; my: number } {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  protected onDblClick(ev: MouseEvent): void {
    if ((ev.target as HTMLElement).closest('[role="button"]')) return;
    const el = this.attached;
    if (!el) return;
    const r = el.getBoundingClientRect();
    this.zoomBy(1.6, ev.clientX - r.left, ev.clientY - r.top);
  }

  private readonly _keys = usePageShortcuts([
    { keys: 'esc', label: 'Clear graph selection', when: () => !!this.selectedId() || this.sheetOpen(), run: () => this.select(null) },
  ]);

  /** Click on empty canvas (not after a pan) clears the selection. */
  protected onCanvasClick(ev: MouseEvent): void {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-graph-node], aside, button')) return;
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.selectedId() || this.sheetOpen()) this.select(null);
  }

  // ── selection ──
  protected onNodeClick(node: GraphNode): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.select(node.id);
  }

  select(id: string | null): void {
    this.selectedId.set(id);
    this.nodeSelected.emit(id ? (this.graph().nodes.find((n) => n.id === id) ?? null) : null);
    if (id && this.showSheet()) {
      this.sheetId.set(id);
      this.sheetOpen.set(true);
    } else if (!id) {
      this.sheetOpen.set(false);
      this.sheetId.set(null);
    }
  }

  protected focusNode(id: string): void {
    this.select(id);
    // pan so the node is visible
    const p = this.layout().nodes.get(id);
    const { w, h } = this.size();
    if (!p || !w) return;
    const k = this.k();
    const sheetW = w >= 640 ? 352 : 0;
    const left = this.tx() + p.x * k;
    const top = this.ty() + p.y * k;
    if (left < 8 || left + p.w * k > w - sheetW) this.tx.set(Math.max(8, (w - sheetW) / 2 - (p.x + p.w / 2) * k));
    if (top < 8 || top + p.h * k > h) this.ty.set(h / 2 - (p.y + p.h / 2) * k);
  }

  // ── appearance helpers ──
  protected isLit(id: string): boolean {
    const l = this.lineage();
    return !l || l.has(id);
  }
  protected dimmed(id: string): boolean {
    const l = this.lineage();
    return !!l && !l.has(id);
  }
  protected isBlocked(id: string): boolean {
    return this.blockedIds().has(id);
  }
  protected markerFor(e: GraphEdge): string {
    const l = this.lineage();
    const lit = !!l && l.has(e.source) && l.has(e.target);
    return `url(#${this.uid}-${lit ? 'c' : e.blocking ? 'b' : 'a'})`;
  }
  protected edgeClass(e: GraphEdge): string {
    const l = this.lineage();
    const lit = !!l && l.has(e.source) && l.has(e.target);
    const dim = !!l && !lit;
    const base = 'transition-[opacity,stroke] duration-150 ';
    if (lit) return base + 'stroke-primary stroke-2';
    const tone =
      e.kind === 'depends_on'
        ? e.blocking
          ? 'stroke-foreground/70 stroke-[1.5]'
          : 'stroke-muted-foreground/50 stroke-[1.5]'
        : 'stroke-muted-foreground/45 stroke-[1.25]';
    return base + tone + (dim ? ' opacity-30' : '');
  }
  protected label(n: GraphNode, long = false): string {
    switch (n.kind) {
      case 'workstream':
        return long ? `${n.entity.key} ${n.entity.title}` : n.entity.key;
      default:
        return n.entity.title;
    }
  }
  protected criteria(w: { acceptanceCriteria: { state: string }[] }): number {
    const total = w.acceptanceCriteria.length;
    return total ? (w.acceptanceCriteria.filter((c) => c.state === 'met').length / total) * 100 : 0;
  }
  protected teamActors(owner: string, others: readonly string[]) {
    return [owner, ...others].map((id) => ({ type: 'team' as const, id }));
  }
  private statusOf(n: GraphNode): AnyStatus {
    switch (n.kind) {
      case 'workstream':
        return n.entity.status;
      default:
        return n.entity.state;
    }
  }
  private accentOf(n: GraphNode, status: AnyStatus): string {
    if (n.kind === 'artifact') {
      const ci = n.entity.ci as CiState | undefined;
      if (ci === 'failing') return statusVar('failing');
      return statusVar(ARTIFACT_ACCENT[n.entity.state]);
    }
    return statusVar(status);
  }
}
