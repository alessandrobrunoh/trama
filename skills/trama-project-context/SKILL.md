---
name: trama-project-context
description: Set up and use repository-specific Trama scope through a root .trama file. Use on first Trama use in a checkout, or when .trama is missing, incomplete, or no longer matches the repository.
---

# Set up Trama context for a repository

Use one `.trama` file at the Git repository root to remember which Trama workspace and project belong to this checkout. This prevents routine issue lookups from searching every project or workspace.

## Read existing context first

1. Find the current Git repository root and read its `.trama` file before searching Trama.
2. The file is TOML, even though its extension is `.trama`. The template below is canonical; the repository's `.trama.example` mirrors it.
3. Compare `repository` with the checkout's normalized Git remote (host and `owner/name`, without credentials, a trailing slash, or `.git`). If they match and `workspace` and `project_id` are set, use those values as the default scope. Do not enumerate projects or workspaces on routine issue lookups.
4. If the file is missing, incomplete, invalid, or its repository does not match, do not guess or silently use a different project's scope. Continue with setup and ask the user for missing or changed values.
5. Never put API keys, tokens, passwords, or other credentials in `.trama`.

## First-time setup

Determine the checkout's remote URL without credentials and, when available, the current Trama workspace using `whoami`. Then ask the user for the required scope in one concise prompt:

- The Trama workspace slug.
- The Trama project for this repository (prefer its exact project ID; a name is enough only if it can be resolved unambiguously in that workspace).
- Confirmation that the detected repository remote is correct.
- Optionally, the associated Goal ID and name.

If the user wants help finding the project, inspect projects only in the workspace they selected and ask them to choose when more than one matches. With MCP, discover `list_projects` through `list_capabilities` and call it through `run_tool` in that workspace; do not search every connected workspace. If a project cannot be resolved, ask for clarification instead of creating a file with a guessed ID.

After the user replies with the required values, create `.trama` at the repository root using this format:

```toml
schema_version = 1
workspace = "workspace-slug"
repository = "github.com/owner/repository"
project_id = "prj_project-id"
project_name = "Project name"
goal_id = ""
goal_name = ""
```

Keep optional Goal values empty when none applies. If `.trama` already exists but is incomplete, preserve its valid values and fill only the missing or user-confirmed fields. Do not replace an existing mapping without the user's confirmation.

## Use saved scope

- For routine issue lookups, pass the saved `project_id` as the issue `projectId` filter (or `--project-id` in the CLI). With MCP, prefer `find_work` with `scope: "issues"` and this project filter when its schema supports them; otherwise discover `list_issues` with `list_capabilities` and call it through `run_tool`. Use the saved workspace when choosing among connected workspaces or CLI profiles.
- Prefer project-filtered issue listing with the requested text/status filters over global full-text search. The global search operation spans multiple resource types and projects.
- A user request that explicitly asks for issues across projects overrides this default; clarify workspace if needed.
- If the saved project no longer exists or the repository remote changes, stop and ask the user to refresh `.trama`. Do not fall back to a broad search.
- `.trama` contains non-secret project context and may be committed so teammates and agents share the mapping.
