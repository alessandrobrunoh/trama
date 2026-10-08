# Security Policy

Security matters especially for Trama because the project is designed to interact with source-code platforms, authentication systems, coding agents, and potentially sensitive organization data.

Trama is currently under active development and is **not yet considered production-ready**.

## Supported versions

Until Trama reaches its first stable release, only the latest version of the `main` branch is actively maintained.

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| Development snapshots / old commits | ❌ |
| Stable releases | Not available yet |

Once stable releases exist, this document will be updated with a formal support policy.

## Reporting a vulnerability

**Do not open a public GitHub Issue for a security vulnerability.**

If GitHub Private Vulnerability Reporting is enabled for this repository, use:

**Repository → Security → Report a vulnerability**

This is the preferred reporting channel.

If private vulnerability reporting is not available, contact the project maintainer privately through the contact information associated with the GitHub repository before sharing technical details publicly.

Please include, where possible:

- a description of the vulnerability;
- affected component or endpoint;
- steps to reproduce;
- expected impact;
- affected versions or commits;
- proof-of-concept material, if appropriate;
- any suggested mitigation.

Do not include secrets, private repository contents, personal data, or unrelated third-party information in your report.

## What happens after a report

The maintainers will aim to:

1. acknowledge the report;
2. reproduce and assess the issue;
3. determine severity and affected versions;
4. prepare a fix;
5. coordinate disclosure when appropriate;
6. publish security guidance or an advisory if users need to take action.

Response times are best-effort while Trama remains an early-stage project.

## Scope

Security reports are especially welcome for issues involving:

- authentication or authorization bypass;
- cross-workspace or cross-tenant data access;
- privilege escalation;
- leakage of GitHub/GitLab credentials;
- leakage of AI provider credentials;
- server-side request forgery;
- remote code execution;
- command or prompt injection that crosses a trust boundary;
- unsafe handling of webhook payloads;
- signature verification failures;
- arbitrary file access;
- SQL injection;
- cross-site scripting;
- CSRF;
- insecure session handling;
- exposure of private repository metadata;
- secrets sent to the browser unexpectedly;
- execution-provider impersonation;
- agent actions attributed to the wrong actor;
- bypass of repository or workspace permissions.

## Out of scope

Unless they result in a meaningful security impact, the following are generally not treated as vulnerabilities:

- issues that require an already-compromised administrator account;
- social engineering without a Trama vulnerability;
- denial of service requiring unrealistic resources;
- missing security headers without demonstrated impact;
- clickjacking on pages that cannot perform sensitive actions;
- self-XSS;
- vulnerabilities in unsupported development snapshots already fixed on `main`;
- vulnerabilities in third-party services with no Trama-specific impact.

## Secrets and credentials

Trama is intended to keep all sensitive integration credentials in server-side storage.

Contributors must never:

- commit API keys, PATs, OAuth secrets, private keys, or passwords;
- store production credentials in test fixtures;
- expose integration secrets through client-side APIs;
- log full authorization headers;
- include real credentials in screenshots, issues, or pull requests.

Use placeholders in examples:

```text
GITHUB_TOKEN=example
AI_PROVIDER_KEY=example
```

## Security expectations for integrations

New integrations should follow these principles:

- least-privilege permissions;
- secrets stored only server-side;
- explicit workspace scoping;
- authenticated webhook sources where supported;
- validation of all untrusted external data;
- no implicit trust based only on URLs, labels, branch names, or agent-provided metadata;
- auditable actions for privileged operations.

## Agent security

Coding agents and external execution providers must be treated as potentially untrusted actors.

Agent-generated content must not automatically grant additional permissions.

Future agent integrations should preserve:

- actor identity;
- workspace boundaries;
- repository permissions;
- execution provenance;
- audit history;
- explicit human approval for sensitive actions where appropriate.

## Disclosure

Please allow maintainers reasonable time to investigate and release a fix before publicly disclosing a vulnerability.

Coordinated disclosure helps protect users while preserving credit for the researcher.

Thank you for helping keep Trama and its users safe.
