import { normalizeCustomerDomain } from '../contracts/domain.js';

/**
 * Mailbox providers: an address there says nothing about the company, so it never matches a customer and
 * never creates one. (A customer that really uses one of these can still be linked by hand in the inbox.)
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.it', 'yahoo.co.uk',
  'yahoo.fr', 'yahoo.de', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com',
  '126.com', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'fastmail.com', 'hey.com', 'tutanota.com', 'duck.com',
  'googlegroups.com',
]);

/** The normalized domain of an email address, or `null`. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : normalizeCustomerDomain(email.slice(at + 1));
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain);
}

/** `mail.eu.acme.com` → `mail.eu.acme.com`, `eu.acme.com`, `acme.com` (never a bare TLD). */
export function candidateDomains(domain: string): string[] {
  const labels = domain.split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export interface DomainOwner {
  id: string;
  domains: readonly string[];
  archivedAt?: Date | null;
}

/**
 * The customer owning the sender's domain: the exact domain first, then its parents, so
 * `jane@support.acme.com` reaches the customer that owns `acme.com`. Free mail domains never match.
 * Archived customers still match (their history belongs together) but lose to an active one.
 */
export function matchCustomerByEmail<T extends DomainOwner>(customers: readonly T[], email: string | null | undefined): T | null {
  const domain = emailDomain(email);
  if (!domain || isFreeMailDomain(domain)) return null;
  for (const candidate of candidateDomains(domain)) {
    const owners = customers.filter((c) => c.domains.includes(candidate));
    if (owners.length) return owners.find((c) => !c.archivedAt) ?? owners[0]!;
  }
  return null;
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

/**
 * The company's own domain: `mail.eu.acme.com` → `acme.com`, `shop.big.co.uk` → `big.co.uk`.
 * A heuristic (no public suffix list): good for the common cases, and the customer can be edited afterwards.
 */
export function companyDomain(domain: string): string {
  const labels = domain.split('.');
  const keep = labels.length > 2 && labels[labels.length - 1]!.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** `acme.com` → `Acme`, `big-corp.co.uk` → `Big Corp`. A starting point an admin can rename. */
export function customerNameFromDomain(domain: string): string {
  const labels = companyDomain(domain).split('.');
  const registrable = labels[0]!;
  return registrable
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}
