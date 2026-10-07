/**
 * Base for persisted rows that are returned to clients as-is.
 * `toJSON` drops nulls/undefined (the contract uses optional fields, never null)
 * and every key listed by `hidden()` (secrets, internal columns).
 * Dates are left as `Date`: JSON.stringify renders them as ISO-8601.
 */
export abstract class Wire {
  protected hidden(): readonly string[] {
    return [];
  }

  toJSON(): Record<string, unknown> {
    const hidden = new Set(this.hidden());
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) {
      if (hidden.has(key) || value === null || value === undefined) continue;
      out[key] = value;
    }
    return out;
  }
}
