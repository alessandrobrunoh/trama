const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const KEY_RE_CI = /\b[A-Za-z][A-Za-z0-9]{1,9}-\d+\b/g;
export function extractKeys(texts, opts = {}) {
    const re = opts.ignoreCase ? KEY_RE_CI : KEY_RE;
    const out = new Set();
    for (const text of texts) {
        if (!text)
            continue;
        for (const m of text.matchAll(re)) {
            const key = m[0].toUpperCase();
            if (!opts.known || opts.known.has(key))
                out.add(key);
        }
    }
    return [...out];
}
//# sourceMappingURL=keys.js.map