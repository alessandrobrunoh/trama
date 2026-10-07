import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
export interface RequestStore {
    clientId?: string;
}
export declare const requestStore: AsyncLocalStorage<RequestStore>;
export declare function requestStoreMiddleware(req: Request, _res: Response, next: NextFunction): void;
