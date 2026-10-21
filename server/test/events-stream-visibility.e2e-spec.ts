import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

type LiveEvent = {
  type: string;
  entity: string;
  id: string;
};

type SseFrame =
  { kind: 'closed' } | { kind: 'timeout' } | { kind: 'data'; data: LiveEvent };

interface SseStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
}

async function nextSseFrame(
  stream: SseStream,
  timeoutMs = 5_000,
): Promise<SseFrame> {
  while (true) {
    const separator = stream.buffer.indexOf('\n\n');
    if (separator >= 0) {
      const frame = stream.buffer.slice(0, separator);
      stream.buffer = stream.buffer.slice(separator + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      if (data) return { kind: 'data', data: JSON.parse(data) as LiveEvent };
      continue;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingRead = (stream.pendingRead ??= stream.reader.read());
    const result = await Promise.race([
      pendingRead.then((value) => ({ kind: 'read' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (result.kind === 'timeout') return { kind: 'timeout' };
    stream.pendingRead = undefined;
    if (result.value.done) return { kind: 'closed' };
    stream.buffer += stream.decoder
      .decode(result.value.value, { stream: true })
      .replace(/\r\n/g, '\n');
  }
}

describe('project-scoped live event streams', () => {
  it('delivers visible events only and closes when project access changes', async () => {
    const previousRecheckMs = process.env.TRAMA_SSE_RECHECK_MS;
    process.env.TRAMA_SSE_RECHECK_MS = '100';
    const abort = new AbortController();
    let app: INestApplication | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      app = await createTestApp();
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address() as AddressInfo | null;
      if (!address || typeof address === 'string')
        throw new Error('The test app did not bind an ephemeral TCP port');
      const server = app.getHttpServer();
      const owner = await Client.signup(server, 'SSE scope owner');
      const workspace = (
        await owner.client
          .post('/api/workspaces', { name: 'SSE visibility' })
          .expect(201)
      ).body;
      const w = `/api/w/${workspace.slug}`;
      const member = await Client.signup(server, 'SSE scope member');
      await owner.client
        .post(`${w}/members`, { email: member.email, role: 'viewer' })
        .expect(201);

      const visibleProject = (
        await owner.client
          .post(`${w}/projects`, { name: 'Visible live project' })
          .expect(201)
      ).body;
      const hiddenProject = (
        await owner.client
          .post(`${w}/projects`, { name: 'Hidden live project' })
          .expect(201)
      ).body;
      const memberships = (await owner.client.get(`${w}/members`).expect(200))
        .body as { id: string; userId: string }[];
      const membership = memberships.find(
        (row) => row.userId === member.user.id,
      );
      expect(membership).toBeDefined();
      await owner.client
        .patch(`${w}/members/${membership!.id}`, {
          access: {
            projects: { all: false, projectIds: [visibleProject.id] },
            includeUnassigned: false,
          },
        })
        .expect(200);

      const response = await fetch(
        `http://127.0.0.1:${address.port}${w}/events/stream`,
        {
          headers: {
            Accept: 'text/event-stream',
            Cookie: member.client.cookieHeader,
          },
          signal: abort.signal,
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      if (!response.body) throw new Error('The SSE response has no body');
      reader = response.body.getReader();
      const stream: SseStream = {
        reader,
        decoder: new TextDecoder(),
        buffer: '',
      };

      await owner.client
        .patch(`${w}/projects/${visibleProject.id}`, {
          name: 'Visible live project updated',
        })
        .expect(200);
      await owner.client
        .patch(`${w}/projects/${hiddenProject.id}`, {
          name: 'Hidden live project updated',
        })
        .expect(200);
      const hiddenIssue = (
        await owner.client
          .post(`${w}/issues`, {
            kind: 'bug',
            title: 'Hidden live issue',
            projectId: hiddenProject.id,
          })
          .expect(201)
      ).body;
      const visibleIssue = (
        await owner.client
          .post(`${w}/issues`, {
            kind: 'bug',
            title: 'Visible live issue',
            projectId: visibleProject.id,
          })
          .expect(201)
      ).body;
      const hiddenComment = (
        await owner.client
          .post(`${w}/comments`, {
            subject: { type: 'issue', id: hiddenIssue.id },
            body: 'hidden live comment',
          })
          .expect(201)
      ).body;
      const visibleComment = (
        await owner.client
          .post(`${w}/comments`, {
            subject: { type: 'issue', id: visibleIssue.id },
            body: 'visible live comment',
          })
          .expect(201)
      ).body;

      const received: LiveEvent[] = [];
      const expectedVisible = [
        { entity: 'project', id: visibleProject.id },
        { entity: 'issue', id: visibleIssue.id },
        { entity: 'comment', id: visibleComment.id },
      ];
      for (let attempts = 0; attempts < 20; attempts += 1) {
        if (
          expectedVisible.every((expected) =>
            received.some(
              (event) =>
                event.entity === expected.entity && event.id === expected.id,
            ),
          )
        )
          break;
        const frame = await nextSseFrame(stream);
        if (frame.kind === 'closed')
          throw new Error('The stream closed before visible events arrived');
        if (frame.kind === 'timeout')
          throw new Error('Timed out before visible events arrived');
        received.push(frame.data);
      }
      const trailing = await nextSseFrame(stream, 500);
      if (trailing.kind === 'data') received.push(trailing.data);

      expect(received).toContainEqual(
        expect.objectContaining({
          entity: 'project',
          id: visibleProject.id,
          type: 'updated',
        }),
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          entity: 'issue',
          id: visibleIssue.id,
          type: 'created',
        }),
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          entity: 'comment',
          id: visibleComment.id,
          type: 'created',
        }),
      );
      expect(received.map((event) => event.id)).not.toContain(hiddenProject.id);
      expect(received.map((event) => event.id)).not.toContain(hiddenIssue.id);
      expect(received.map((event) => event.id)).not.toContain(hiddenComment.id);
      expect(trailing).toEqual({ kind: 'timeout' });

      await owner.client
        .patch(`${w}/members/${membership!.id}`, {
          access: {
            projects: { all: false, projectIds: [] },
            includeUnassigned: false,
          },
        })
        .expect(200);
      await expect(nextSseFrame(stream, 3_000)).resolves.toEqual({
        kind: 'closed',
      });
    } finally {
      abort.abort();
      await reader?.cancel().catch(() => undefined);
      await app?.close();
      if (previousRecheckMs === undefined)
        delete process.env.TRAMA_SSE_RECHECK_MS;
      else process.env.TRAMA_SSE_RECHECK_MS = previousRecheckMs;
    }
  });
});
