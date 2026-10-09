import {
  candidateDomains,
  companyDomain,
  customerNameFromDomain,
  emailDomain,
  isFreeMailDomain,
  matchCustomerByEmail,
} from './intake-domain.js';

const acme = { id: 'cus_acme', domains: ['acme.com', 'acme.io'] };
const beta = { id: 'cus_beta', domains: ['beta.co.uk'] };

describe('intake domain matching', () => {
  it('reads the domain of an address', () => {
    expect(emailDomain('Jane@ACME.com')).toBe('acme.com');
    expect(emailDomain('jane@www.acme.com')).toBe('acme.com');
    expect(emailDomain('not an email')).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
  });

  it('matches any of the customer domains, not only the primary', () => {
    expect(matchCustomerByEmail([acme, beta], 'jane@acme.io')?.id).toBe('cus_acme');
    expect(matchCustomerByEmail([acme, beta], 'sam@beta.co.uk')?.id).toBe('cus_beta');
  });

  it('matches subdomains through their parent', () => {
    expect(candidateDomains('mail.eu.acme.com')).toEqual(['mail.eu.acme.com', 'eu.acme.com', 'acme.com']);
    expect(matchCustomerByEmail([acme], 'jane@support.eu.acme.com')?.id).toBe('cus_acme');
  });

  it('does not match a look-alike domain', () => {
    expect(matchCustomerByEmail([acme], 'jane@notacme.com')).toBeNull();
    expect(matchCustomerByEmail([acme], 'jane@acme.com.evil.io')).toBeNull();
  });

  it('never matches a mailbox provider, even if a customer lists it', () => {
    expect(isFreeMailDomain('gmail.com')).toBe(true);
    expect(matchCustomerByEmail([{ id: 'cus_g', domains: ['gmail.com'] }], 'jane@gmail.com')).toBeNull();
    expect(matchCustomerByEmail([acme], undefined)).toBeNull();
  });

  it('prefers an active customer over an archived one that shares the domain', () => {
    const archived = { id: 'cus_old', domains: ['acme.com'], archivedAt: new Date() };
    expect(matchCustomerByEmail([archived, acme], 'a@acme.com')?.id).toBe('cus_acme');
    expect(matchCustomerByEmail([archived], 'a@acme.com')?.id).toBe('cus_old');
  });

  it('derives the company domain and a name for auto-created customers', () => {
    expect(companyDomain('mail.eu.acme.com')).toBe('acme.com');
    expect(companyDomain('shop.big-corp.co.uk')).toBe('big-corp.co.uk');
    expect(companyDomain('acme.com')).toBe('acme.com');
    expect(customerNameFromDomain('acme.com')).toBe('Acme');
    expect(customerNameFromDomain('support.big-corp.co.uk')).toBe('Big Corp');
  });
});
