// UiStore — app-level UI state shared by shell, keyboard service and overlays.
// Persisted (localStorage 'nabla.ui.v1'): sidebarCollapsed + folded sidebar sections. Theme lives in core/theme.
import { Injectable, computed, effect, signal } from '@angular/core';
import { oneOf, readJson, writeJson } from './storage';

/** Which global overlay is open (one at a time). */
export type ModalKind =
  | 'command'
  | 'search'
  | 'shortcuts'
  | 'customize-sidebar'
  | 'create'
  | 'confirm-delete'
  | null;

/** How a sidebar entry is shown: always, only while it has a badge, or not at all. */
export type SidebarVisibility = 'always' | 'badged' | 'hidden';
export type SidebarBadgeStyle = 'count' | 'dot';
export type SidebarSection = 'personal' | 'workspace';

const SIDEBAR_VISIBILITIES = ['always', 'badged', 'hidden'] as const;
const SIDEBAR_BADGE_STYLES = ['count', 'dot'] as const;
const SIDEBAR_SECTIONS = ['personal', 'workspace'] as const;

/** What the global "create" dialog creates. */
export type CreateKind =
  | 'workstream'
  | 'issue'
  | 'decision'
  | 'artifact'
  | 'view'
  | 'team'
  | 'repository'
  | 'input-request';

/** Prefill for the create dialog, e.g. `{ workstreamId }`, `{ ownerTeamId }`, `{ kind: 'bug' }`. */
export type CreateDefaults = Record<string, unknown>;

export interface ConfirmDeleteState {
  title: string;
  description: string;
  /** Label of the destructive button (default "Delete"). */
  confirmLabel?: string;
  /** `false` renders the confirm button in the primary style (non-destructive confirmations). */
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}

interface PersistedUi {
  sidebarCollapsed: boolean;
  /** Sidebar section / team ids the user folded away. */
  foldedSections: string[];
  sidebarBadgeStyle: SidebarBadgeStyle;
  /** Per sidebar entry (path segment); missing means "always". */
  sidebarVisibility: Record<string, SidebarVisibility>;
  /** Custom order per section (path segments); entries not listed keep their default place after these. */
  sidebarOrder: Record<SidebarSection, string[]>;
}

function readVisibility(value: unknown): Record<string, SidebarVisibility> {
  const out: Record<string, SidebarVisibility> = {};
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value))
      if (typeof v === 'string' && (SIDEBAR_VISIBILITIES as readonly string[]).includes(v))
        out[k] = v as SidebarVisibility;
  return out;
}

function readOrder(value: unknown): Record<SidebarSection, string[]> {
  const out: Record<SidebarSection, string[]> = { personal: [], workspace: [] };
  if (value && typeof value === 'object')
    for (const section of SIDEBAR_SECTIONS) {
      const list = (value as Record<string, unknown>)[section];
      if (Array.isArray(list)) out[section] = list.filter((x): x is string => typeof x === 'string');
    }
  return out;
}

export const UI_STORAGE_KEY = 'nabla.ui.v1';

@Injectable({ providedIn: 'root' })
export class UiStore {
  private readonly persisted = readJson<PersistedUi>(UI_STORAGE_KEY);

  readonly sidebarCollapsed = signal<boolean>(
    typeof this.persisted?.sidebarCollapsed === 'boolean' ? this.persisted.sidebarCollapsed : false,
  );
  /** Folded sidebar groups ("teams", "views", "team:<id>"). Persisted. */
  readonly foldedSections = signal<string[]>(
    Array.isArray(this.persisted?.foldedSections) ? this.persisted.foldedSections.filter((x) => typeof x === 'string') : [],
  );
  /** "Customize sidebar" preferences. Persisted. */
  readonly sidebarBadgeStyle = signal<SidebarBadgeStyle>(
    oneOf(this.persisted?.sidebarBadgeStyle, SIDEBAR_BADGE_STYLES, 'count'),
  );
  readonly sidebarVisibility = signal<Record<string, SidebarVisibility>>(
    readVisibility(this.persisted?.sidebarVisibility),
  );
  readonly sidebarOrder = signal<Record<SidebarSection, string[]>>(
    readOrder(this.persisted?.sidebarOrder),
  );
  readonly mobileSidebarOpen = signal(false);
  readonly modal = signal<ModalKind>(null);
  readonly createKind = signal<CreateKind>('workstream');
  readonly createDefaults = signal<CreateDefaults>({});
  readonly confirmDelete = signal<ConfirmDeleteState | null>(null);
  /** True right after "g" is pressed (G-chord pending); show a hint if you like. */
  readonly pendingG = signal(false);
  /** Keyboard-focused list row (`data-row-id`). */
  readonly focusedRowId = signal<string | null>(null);
  /** Multi-selected list rows (`data-row-id`). */
  readonly selectedRowIds = signal<string[]>([]);

  readonly commandPaletteOpen = computed(() => this.modal() === 'command');
  readonly hasSelection = computed(() => this.selectedRowIds().length > 0);
  readonly selectedSet = computed(() => new Set(this.selectedRowIds()));

  constructor() {
    effect(() => {
      writeJson(UI_STORAGE_KEY, {
        sidebarCollapsed: this.sidebarCollapsed(),
        foldedSections: this.foldedSections(),
        sidebarBadgeStyle: this.sidebarBadgeStyle(),
        sidebarVisibility: this.sidebarVisibility(),
        sidebarOrder: this.sidebarOrder(),
      } satisfies PersistedUi);
    });
  }

  // sidebar
  setSidebarCollapsed(value: boolean): void {
    this.sidebarCollapsed.set(value);
  }
  toggleSidebar(): void {
    this.sidebarCollapsed.update((v) => !v);
  }
  isFolded(id: string): boolean {
    return this.foldedSections().includes(id);
  }
  toggleFolded(id: string): void {
    this.foldedSections.update((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  }
  sidebarVisibilityOf(segment: string): SidebarVisibility {
    return this.sidebarVisibility()[segment] ?? 'always';
  }
  setSidebarVisibility(segment: string, value: SidebarVisibility): void {
    this.sidebarVisibility.update((v) => {
      const { [segment]: _, ...rest } = v;
      return value === 'always' ? rest : { ...rest, [segment]: value };
    });
  }
  /** Stores the full order of one section (the segments as currently listed, after a move). */
  setSidebarOrder(section: SidebarSection, segments: string[]): void {
    this.sidebarOrder.update((o) => ({ ...o, [section]: segments }));
  }
  resetSidebarLayout(): void {
    this.sidebarBadgeStyle.set('count');
    this.sidebarVisibility.set({});
    this.sidebarOrder.set({ personal: [], workspace: [] });
  }
  setMobileSidebar(value: boolean): void {
    this.mobileSidebarOpen.set(value);
  }

  // modals
  openModal(modal: ModalKind): void {
    this.modal.set(modal);
    this.mobileSidebarOpen.set(false);
  }
  closeModal(): void {
    this.modal.set(null);
    this.confirmDelete.set(null);
  }
  openCommandPalette(): void {
    this.openModal('command');
  }
  toggleCommandPalette(): void {
    if (this.modal() === 'command') this.closeModal();
    else this.openModal('command');
  }
  /** Open the create dialog for `kind`. */
  openCreate(kind: CreateKind, defaults: CreateDefaults = {}): void {
    this.createKind.set(kind);
    this.createDefaults.set(defaults);
    this.openModal('create');
  }
  /** Opens the confirm dialog (or closes it when `state` is null). */
  setConfirmDelete(state: ConfirmDeleteState | null): void {
    this.confirmDelete.set(state);
    this.modal.set(state ? 'confirm-delete' : null);
  }
  setPendingG(value: boolean): void {
    this.pendingG.set(value);
  }

  // list focus / selection
  setFocusedRow(id: string | null): void {
    this.focusedRowId.set(id);
  }
  /** Toggle one id; pass `range` (the full new selection) for shift-click range selection. */
  toggleSelected(id: string, range?: string[]): void {
    if (range) {
      this.selectedRowIds.set(range);
      return;
    }
    this.selectedRowIds.update((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }
  setSelected(ids: string[]): void {
    this.selectedRowIds.set(ids);
  }
  clearSelected(): void {
    this.selectedRowIds.set([]);
  }
}
