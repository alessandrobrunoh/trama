import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
function safeEqual(a, b) {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function verifyGithubSignature(secret, rawBody, header) {
    if (!header?.startsWith('sha256='))
        return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return safeEqual(expected, header);
}
export function signGithub(secret, body) {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
export function verifyGitlabToken(secret, header) {
    return !!header && safeEqual(secret, header);
}
//# sourceMappingURL=signatures.js.map