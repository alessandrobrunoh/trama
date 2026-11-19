---
name: trama-project-context
description: Set up and use repository-specific Trama scope through a root .trama file. Use on first Trama use in a checkout, or when .trama is missing, incomplete, or no longer matches the repository.
---

# Set up Trama context for a repository

Use one `.trama` file at the Git repository root to remember which Trama workspace and project belong to this checkout. This prevents routine task lookups from searching every project or workspace.

## Read existing context first

1. Find the current Git repository root and read its `.trama` file before searching Trama.
2. The file is TOML, even though its extension is `.trama`. The template below is canonical; the repository's `.trama.example` mirrors it.
3. Compare `repository` with the checkout's normalized Git remote (host and `owner/name`, without credentials, a trailing slash, or `.git`). If they match and `workspace` and `project_id` are set, use those values as the default scope. Do not enumerate projects or workspaces on routine task lookups.
4. If the file is missing, incomplete, invalid, or its repository does not match, do not guess or silently use a different project's scope. Continue with setup and ask the user for missing or changed values.
5. Never put API keys, tokens, passwords, or other credentials in `.trama`.

## First-time setup

Determine the checkout's remote URL without credentials and, when available, the current Trama workspace using `whoami`. Then ask the user for the required scope in one concise prompt:

- The Trama workspace slug.
- The Trama project for this repository (prefer its exact project ID; a name is enough only if it can be resolved unambiguously in that workspace).
- Confirmation that the detected repository remote is correct.

If the user wants help finding the project, call `list_projects` in the workspace they selected, filtered by `repository` (`owner/name` or URL). Do not search every connected workspace. When more than one project matches, ask them to choose. If a project cannot be resolved, ask for clarification instead of creating a file with a guessed ID.

After the user replies with the required values, create `.trama` at the repository root using this format:

```toml
schema_version = 1
workspace = "workspace-slug"
repository = "github.com/owner/repository"
project_id = "prj_project-id"
project_name = "Project name"
```

If `.trama` already exists but is incomplete, preserve its valid values and fill only the missing or user-confirmed fields. Do not replace an existing mapping without the user's confirmation. Older files may carry `goal_id` and `goal_name` lines; they are ignored and can be removed.

## Use saved scope

- For routine task lookups, pass the saved `project_id` as the `projectId` filter (or `--project-id` in the CLI): `find_work` with `projectId` over MCP, `trama task list --project-id …` in the shell. Use the saved workspace when choosing among connected workspaces or CLI profiles.
- Prefer project-filtered listing with the requested text/status filters over global full-text search. The global search operation spans multiple resource types and projects.
- A user request that explicitly asks for tasks across projects overrides this default; clarify workspace if needed.
- If the saved project no longer exists or the repository remote changes, stop and ask the user to refresh `.trama`. Do not fall back to a broad search.
- `.trama` contains non-secret project context and may be committed so teammates and agents share the mapping.
