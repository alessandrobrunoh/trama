import { AsyncLocalStorage } from 'node:async_hooks';
export const requestStore = new AsyncLocalStorage();
export function requestStoreMiddleware(req, _res, next) {
    const header = req.headers['x-client-id'];
    requestStore.run({ clientId: typeof header === 'string' ? header.slice(0, 64) : undefined }, next);
}
//# sourceMappingURL=request-store.js.map