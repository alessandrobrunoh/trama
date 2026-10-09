import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  ApiClient,
  ApiError,
  LiveSync,
  NablaStore,
  Notifier,
  type CreateDocumentInput,
  type Document,
  type DocumentConflict,
  type DocumentOwnerInput,
  type DocumentsQuery,
  type ID,
  type UpdateDocumentInput,
} from '../../core';

/** The current document the server sent with a 409, when the error is a document conflict. */
export function conflictOf(e: unknown): Document | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body as Partial<DocumentConflict> | undefined;
  return body?.code === 'document_conflict' && body.current ? (body.current as Document) : null;
}

/**
 * Documents of the open workspace. They are not part of the workspace snapshot (bodies are large), so lists
 * and pages load them on demand; `changes` ticks whenever a document or a document attachment changes, here
 * or elsewhere, so open lists refetch.
 */
@Injectable({ providedIn: 'root' })
export class Documents {
  private readonly api = inject(ApiClient);
  private readonly store = inject(NablaStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);

  /** Bumps on every change to a document or a `document` artifact (own writes and live events). */
  readonly changes = signal(0);

  constructor() {
    inject(LiveSync).events$.subscribe((e) => {
      if (e.entity === 'document' || e.entity === 'artifact') this.changes.update((n) => n + 1);
    });
  }

  private slug(): string {
    const slug = this.store.slug();
    if (!slug) throw new Error('No workspace is open');
    return slug;
  }

  private touched<T>(value: T): T {
    this.changes.update((n) => n + 1);
    return value;
  }

  list(query: DocumentsQuery = {}) {
    return this.api.documents.list(this.slug(), query);
  }

  get(id: ID) {
    return this.api.documents.get(this.slug(), id);
  }

  async create(input: CreateDocumentInput) {
    return this.touched(await this.api.documents.create(this.slug(), input));
  }

  /** Quiet: the editor handles 403/409 itself. */
  async update(id: ID, input: UpdateDocumentInput) {
    return this.touched(await this.api.documents.update(this.slug(), id, input, { quiet: true }));
  }

  async archive(id: ID) {
    return this.touched(await this.api.documents.archive(this.slug(), id));
  }

  async restore(id: ID) {
    return this.touched(await this.api.documents.restore(this.slug(), id));
  }

  async remove(id: ID) {
    await this.api.documents.remove(this.slug(), id);
    this.touched(null);
  }

  revisions(id: ID) {
    return this.api.documents.revisions(this.slug(), id);
  }

  revision(id: ID, version: number) {
    return this.api.documents.revision(this.slug(), id, version);
  }

  async restoreRevision(id: ID, version: number, baseVersion: number) {
    return this.touched(
      await this.api.documents.restoreRevision(this.slug(), id, version, baseVersion),
    );
  }

  async attach(id: ID, owner: DocumentOwnerInput) {
    return this.touched(await this.api.documents.attach(this.slug(), id, owner));
  }

  async detach(id: ID, artifactId: ID) {
    return this.touched(await this.api.documents.detach(this.slug(), id, artifactId));
  }

  /** Router commands to a document page. */
  path(id: ID): string[] {
    return ['/', this.slug(), 'documents', id];
  }

  open(id: ID): void {
    void this.router.navigate(this.path(id));
  }

  /** Creates an empty, titled-"Untitled" document (attached to `owner` when given) and opens it. */
  async createAndOpen(owner: DocumentOwnerInput = {}): Promise<Document | null> {
    try {
      const doc = await this.create({ title: 'Untitled', ...owner });
      this.open(doc.id);
      return doc;
    } catch (e) {
      this.notifier.error(e instanceof ApiError ? e.message : 'Could not create the document');
      return null;
    }
  }
}
