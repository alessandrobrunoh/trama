// UiStore — app-level UI state shared by shell, keyboard service and overlays.
// Persisted (localStorage 'nabla.ui.v1'): sidebarCollapsed only. Theme lives in core/theme.
import { Injectable, computed, effect, signal } from '@angular/core';
import { readJson, writeJson } from './storage';

/** Which global overlay is open (one at a time). */
export type ModalKind = 'command' | 'search' | 'shortcuts' | 'create' | 'confirm-delete' | null;

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
  onConfirm: () => Promise<void> | void;
}

interface PersistedUi {
  sidebarCollapsed: boolean;
}

export const UI_STORAGE_KEY = 'nabla.ui.v1';

@Injectable({ providedIn: 'root' })
export class UiStore {
  private readonly persisted = readJson<PersistedUi>(UI_STORAGE_KEY);

  readonly sidebarCollapsed = signal<boolean>(
    typeof this.persisted?.sidebarCollapsed === 'boolean' ? this.persisted.sidebarCollapsed : false,
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
      writeJson(UI_STORAGE_KEY, { sidebarCollapsed: this.sidebarCollapsed() } satisfies PersistedUi);
    });
  }

  // sidebar
  setSidebarCollapsed(value: boolean): void {
    this.sidebarCollapsed.set(value);
  }
  toggleSidebar(): void {
    this.sidebarCollapsed.update((v) => !v);
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
