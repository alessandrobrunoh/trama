import { AsyncLocalStorage } from 'node:async_hooks';
import type { UploadCaller } from '../uploads/upload-rules.js';

/** Set for the request, alongside member access, so a text save can check the files it embeds. */
export const uploadCallerStore = new AsyncLocalStorage<UploadCaller>();

export function currentUploadCaller(): UploadCaller | null {
  return uploadCallerStore.getStore() ?? null;
}
