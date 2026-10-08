# Contributing to Trama

Thank you for your interest in contributing to Trama.

Trama is an early-stage source-available project exploring a different model for coordinating software work across humans, coding agents, teams, repositories, and delivery systems.

Because the architecture is still evolving, **design alignment matters as much as implementation quality**.

## Before you start

Small fixes, documentation improvements, tests, accessibility improvements, and clearly scoped bug fixes can usually go directly to a pull request.

For larger changes, please open a GitHub Issue or Discussion first.

This is especially important for changes involving:

- the Workstream domain model;
- Executions;
- Artifacts;
- Decisions;
- Attention;
- authentication;
- workspace permissions;
- database schema;
- GitHub or GitLab integration;
- Delta integration;
- MCP;
- agent permissions;
- self-hosting architecture;
- major UI navigation changes.

The goal is to avoid contributors spending significant time implementing competing abstractions.

## Project principles

Contributions should generally reinforce these principles:

1. **Work over tickets**  
   A Workstream represents an outcome, not just a task card.

2. **Humans and agents are both actors**  
   Agent activity should be explicit and auditable.

3. **Human attention is scarce**  
   Trama should surface where human judgment is needed.

4. **Reality should drive status**  
   Git, CI, reviews, executions, and deployments should determine state whenever possible.

5. **Context should be reusable**  
   Decisions, dependencies, acceptance criteria, and outcomes should remain useful to future humans and agents.

6. **Multi-team is the default**  
   Avoid assumptions that every unit of work belongs to exactly one team.

7. **Self-hosting matters**  
   Avoid architecture that unnecessarily requires a large infrastructure stack.

8. **Integrations should be replaceable**  
   Do not make core domain concepts depend on one vendor.

## Development setup

Clone the repository:

```bash
git clone https://github.com/alessandrobrunoh/trama.git
cd trama
```

Install dependencies:

```bash
npm install
```

Start development:

```bash
npm run dev
```

## Quality checks

Before submitting a pull request, run:

```bash
npm run typecheck
npm run test
npm run lint
npm run build
```

If your change affects behavior, add or update tests where practical.

Do not disable checks simply to make a pull request pass.

## Pull requests

A good pull request should explain:

- what problem it solves;
- why the change is needed;
- the chosen approach;
- important trade-offs;
- screenshots or recordings for meaningful UI changes;
- any migration or compatibility impact;
- how the change was tested.

Keep pull requests focused.

A smaller coherent pull request is easier to review than a large pull request mixing refactoring, formatting, features, and unrelated fixes.

## Draft pull requests

Draft pull requests are welcome for early architectural feedback.

Use them when:

- the implementation is incomplete;
- you want feedback on an API or data model;
- the change is large and you want to validate the direction first.

## Commit messages

There is no strict conventional-commit requirement yet, but commit messages should be clear and useful.

Good examples:

```text
Add workstream repository relation
Fix workspace scoping in execution query
Refactor GitHub webhook verification
Document agent identity model
```

Avoid messages such as:

```text
fix
changes
stuff
wip final
```

## Branches

Use short descriptive branch names when possible.

Examples:

```text
feat/workstreams
feat/github-webhooks
fix/workspace-isolation
docs/security-policy
```

## Code style

Follow the conventions already present in the codebase.

In particular:

- prefer TypeScript types that model domain concepts explicitly;
- avoid `any` unless there is a strong reason;
- validate untrusted external input;
- keep UI state separate from persisted domain state;
- keep secrets server-side;
- keep workspace/tenant boundaries explicit;
- avoid coupling core domain models to specific agent vendors;
- prefer straightforward code over unnecessary abstractions.

Formatting is handled by the repository tooling.

## Domain changes

Changes to core domain concepts should consider both human and agent workflows.

Before introducing a field such as:

```text
assigneeId
status
provider
teamId
```

consider whether the relationship is actually:

- one-to-one;
- one-to-many;
- many-to-many;
- derived rather than persisted;
- provider-specific rather than domain-level.

Trama intentionally avoids reproducing traditional issue-tracker assumptions when they do not fit agentic engineering workflows.

## Database changes

Database migrations should:

- be explicit;
- preserve existing data where reasonable;
- avoid destructive migrations without a clear reason;
- keep workspace isolation intact;
- include indexes for important lookup paths;
- avoid storing secrets in general domain tables.

If a migration requires manual action, document it clearly in the pull request.

## Security

Read [SECURITY.md](./SECURITY.md) before working on authentication, authorization, integrations, webhooks, credentials, or agent execution.

Never commit:

- passwords;
- API keys;
- access tokens;
- OAuth secrets;
- private keys;
- production database URLs;
- private repository data.

Use fake values in fixtures and examples.

## UI contributions

Trama should remain fast, compact, keyboard-friendly, and information-dense without becoming visually noisy.

For significant UI changes:

- include screenshots;
- test both narrow and wide layouts;
- preserve keyboard navigation;
- consider loading, empty, error, and permission states;
- avoid hiding critical state only behind hover interactions;
- maintain accessible labels and focus behavior.

## Integrations

External integrations must be treated as trust boundaries.

Integration contributions should document:

- required permissions/scopes;
- authentication method;
- webhook verification where applicable;
- rate-limit behavior;
- failure behavior;
- what data leaves Trama;
- what credentials are stored.

Provider-specific concepts should remain behind adapters whenever practical.

## AI and agent integrations

Do not assume an agent is equivalent to a trusted human user.

Agent actions should eventually be attributable to:

```text
workspace
workstream
execution
provider
actor
```

Changes that allow agents to perform privileged operations should receive additional review.

## Documentation

Documentation improvements are first-class contributions.

Useful areas include:

- architecture;
- domain concepts;
- self-hosting;
- integrations;
- security;
- API usage;
- MCP;
- contribution guides;
- troubleshooting.

## Reporting bugs

A useful bug report should include:

- expected behavior;
- actual behavior;
- reproduction steps;
- browser/runtime information where relevant;
- screenshots or logs when useful;
- the commit or version being used.

Do not include secrets or private repository contents.

Security issues must follow [SECURITY.md](./SECURITY.md), not the public issue tracker.

## Feature requests

Feature requests should explain the underlying problem before proposing a specific UI or implementation.

Prefer:

> When several agents work on the same Workstream, it is difficult to see which execution currently needs human input.

over:

> Add a purple button next to the title.

Understanding the problem helps us find a solution that fits the broader product model.

## Code of Conduct

By participating in this project, you agree to follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License and Contributor License Agreement

The project is source-available under the [PolyForm Shield License 1.0.0](./LICENSE). Anyone may use, modify and self-host it, but not to build a competing product or service.

Before a pull request can be merged, you must agree to the [Contributor License Agreement](./CLA.md). You keep the copyright on your contribution; the CLA gives the maintainer the rights needed to distribute it under the project's license, and to offer the project under other terms (for example a commercial license or a hosted service) in the future.

To sign, comment on your pull request:

> I have read the CLA Document and I hereby sign the CLA.

You only need to do this once. You confirm that you have the right to submit the contribution, and that your employer (if any) does not claim rights over it.

## Questions

If you are unsure whether an idea fits Trama, open a GitHub Discussion or a small design issue before implementing it.

Thoughtful disagreement about architecture and product direction is welcome.

The objective is not to preserve the current implementation. It is to build the best open coordination layer we can for human + agent engineering teams.
