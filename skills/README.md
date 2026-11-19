# Trama agent skills

Skills teach a coding agent how to work in Trama through the [MCP server](../mcp/README.md) (or the [`trama` CLI](../cli/README.md)): what each
object is for, which tools to call, and the rules that keep the workspace trustworthy. They use the standard
`SKILL.md` format (a folder with a `SKILL.md` file and YAML frontmatter), so any skills-aware agent can load them.

| Skill | Use it when |
|---|---|
| [`trama`](trama/SKILL.md) | Always first: concepts, ground rules, tool map, and the tasks of this checkout |
| [`trama-project-context`](trama-project-context/SKILL.md) | First use in a repository: create or refresh `.trama` and scope future task lookups |
| [`trama-workflow`](trama-workflow/SKILL.md) | Task-first work across one or more tasks |
| [`trama-start-work`](trama-start-work/SKILL.md) | Reading context and starting implementation |
| [`trama-report-progress`](trama-report-progress/SKILL.md) | Recording factual progress and artifacts on tasks |
| [`trama-triage-tasks`](trama-triage-tasks/SKILL.md) | Filing, finding, and triaging tasks |
| [`trama-cli`](trama-cli/SKILL.md) | The same work through the `trama` shell command, when MCP is unavailable (`trama skill install` installs it) |

For repository-specific scope, `trama-project-context` reads or creates a root `.trama` file containing the workspace, repository, and project mapping. Its format is shown in [`.trama.example`](../.trama.example); it contains no credentials and can be committed to share the mapping with teammates.

## Install

Claude Code, for all your projects:

```bash
mkdir -p ~/.claude/skills && cp -R skills/trama* ~/.claude/skills/
```

Or for one repository: copy them to `<repo>/.claude/skills/`. Other agents: put the folders wherever that
agent loads skills from. If you installed an earlier version, delete the old `trama-triage-issues` and
`trama-ask-and-decide` folders: they were replaced by `trama-triage-tasks` and removed.

Connect the MCP server too (the skills assume its tools exist). Use the deployed tool catalog and `list_capabilities` + `run_tool` to discover the current operations and exact arguments; see [Tool profiles](../mcp/README.md#tool-profiles):

```bash
claude mcp add --transport http trama https://<your-trama-host>/mcp \
  --header "Authorization: Bearer trm_…"
# several workspaces, one key each: Bearer trm_one,trm_two
```

Create the key in Trama under Settings → API tokens. Give agents the narrowest permissions that do the job
(see `trama-report-progress` for what it writes), and keep the default usage caps. One key is bound to one
workspace. To cover more, connect several keys (comma-separated bearer, or `trama mcp` after `trama account add`).
Reads then span every connected workspace; writes still need exactly one (`workspace` on MCP, `--workspace` on the CLI).

## Keeping them accurate

The skills describe behaviour that lives in code. When it changes, update them:

- Tool names and parameters: verify against `mcp/src/tools.json` and `mcp/src/curated.json` (and `trama commands`) before adding concrete examples.
- Domain behavior and supported states: verify against current contracts and server behavior before documenting lifecycle rules.
- `trama-cli/SKILL.md` is embedded in the CLI binary and every example in it is run as a parse test by `cli/tests/cli.rs`; run the CLI tests after editing it.
