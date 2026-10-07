export class Wire {
    hidden() {
        return [];
    }
    toJSON() {
        const hidden = new Set(this.hidden());
        const out = {};
        for (const [key, value] of Object.entries(this)) {
            if (hidden.has(key) || value === null || value === undefined)
                continue;
            out[key] = value;
        }
        return out;
    }
}
//# sourceMappingURL=wire.js.map