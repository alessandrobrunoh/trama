export function captureWebhookRawBody(req, _res, buf) {
    const r = req;
    if ((r.originalUrl ?? r.url ?? '').startsWith('/api/webhooks/'))
        r.rawBody = Buffer.from(buf);
}
//# sourceMappingURL=raw-body.js.map