import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface RequestStore {
  /** `X-Client-Id` of the originating request (echoed on SSE LiveEvents). */
  clientId?: string;
}

export const requestStore = new AsyncLocalStorage<RequestStore>();

export function requestStoreMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers['x-client-id'];
  requestStore.run(
    { clientId: typeof header === 'string' ? header.slice(0, 64) : undefined },
    next,
  );
}
