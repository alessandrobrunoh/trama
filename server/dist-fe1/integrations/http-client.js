var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable } from '@nestjs/common';
export class HttpClient {
}
let FetchHttpClient = class FetchHttpClient extends HttpClient {
    async request(req) {
        const res = await fetch(req.url, {
            method: req.method ?? 'GET',
            headers: { ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...req.headers },
            body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
            signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
            redirect: 'error',
        });
        const text = await res.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            }
            catch {
                json = null;
            }
        }
        const headers = {};
        res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        return { status: res.status, headers, json };
    }
};
FetchHttpClient = __decorate([
    Injectable()
], FetchHttpClient);
export { FetchHttpClient };
export class ProviderHttpError extends Error {
    status;
    rateLimitedUntil;
    constructor(status, message, rateLimitedUntil) {
        super(message);
        this.status = status;
        this.rateLimitedUntil = rateLimitedUntil;
    }
    get rateLimited() {
        return !!this.rateLimitedUntil;
    }
}
//# sourceMappingURL=http-client.js.map