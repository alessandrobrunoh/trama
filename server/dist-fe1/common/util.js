import { randomBytes } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
export function uid(prefix) {
    const rand = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
    return `${prefix}_${rand.toLowerCase()}`;
}
export function notFound(entity, id) {
    return new NotFoundException(`${entity} "${id}" not found`);
}
export function definedOnly(input) {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
export function slugify(input) {
    return input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}
export function unique(items) {
    return [...new Set(items ?? [])];
}
export function toDate(value) {
    if (value === null || value === undefined)
        return value;
    return value instanceof Date ? value : new Date(value);
}
//# sourceMappingURL=util.js.map