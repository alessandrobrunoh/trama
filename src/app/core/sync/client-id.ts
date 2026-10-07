/** Per-tab id sent as `X-Client-Id` on writes; SSE events carrying it are ignored by this tab. */
export const CLIENT_ID: string = `tab-${
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}`;
