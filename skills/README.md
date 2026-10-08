# Trama agent skills

Skills teach a coding agent how to work in Trama through the [MCP server](../mcp/README.md) (or the [`trama` CLI](../cli/README.md)): what each
object is for, which tools to call, and the rules that keep the workspace trustworthy. They use the standard
`SKILL.md` format (a folder with a `SKILL.md` file and YAML frontmatter), so any skills-aware agent can load them.

| Skill | Use it when |
|---|---|
| [`trama`](trama/SKILL.md) | Always first: concepts, ground rules, tool map |
| [`trama-workflow`](trama-workflow/SKILL.md) | The work cycle: search, reuse or create the workstream, then hand off |
| [`trama-start-work`](trama-start-work/SKILL.md) | Picking up a workstream or issue |
| [`trama-report-progress`](trama-report-progress/SKILL.md) | Recording criteria, PRs, CI, issue status |
| [`trama-ask-and-decide`](trama-ask-and-decide/SKILL.md) | Blocked, or a choice should be recorded |
| [`trama-triage-issues`](trama-triage-issues/SKILL.md) | Filing, deduplicating and grouping issues |
| [`trama-cli`](trama-cli/SKILL.md) | The same work through the `trama` shell command, when MCP is unavailable (`trama skill install` installs it) |

## Install

Claude Code, for all your projects:

```bash
mkdir -p ~/.claude/skills && cp -R skills/trama* ~/.claude/skills/
```

Or for one repository: copy them to `<repo>/.claude/skills/`. Other agents: put the folders wherever that
agent loads skills from.

Connect the MCP server too (the skills assume its tools exist):

```bash
claude mcp add --transport http trama https://<your-trama-host>/mcp \
  --header "Authorization: Bearer nbl_…"
# several workspaces, one key each: Bearer nbl_one,nbl_two
```

Create the key in Trama under Settings → API tokens. Give agents the narrowest permissions that do the job
(see `trama-report-progress` for what it writes), and keep the default usage caps. One key is bound to one
workspace. To cover more, connect several keys (comma-separated bearer, or `trama mcp` after `trama account add`).
Reads then span every connected workspace; writes still need exactly one (`workspace` on MCP, `--workspace` on the CLI).

## Keeping them accurate

The skills describe behaviour that lives in code. When it changes, update them:

- Status derivation: `server/src/status/derive-status.ts`
- Tool names and parameters: `mcp/src/tools.json` (the CLI's commands and flags come from it too; `cli/tests/cli.rs` checks that every example in `trama-cli/SKILL.md` still parses)
- Enums and defaults (kinds, states, token limits): `contracts/domain.ts`
