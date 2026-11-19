# Trama Vision

> **Tasks describe problems. Comments and artifacts preserve what helps the work continue.**

This is the authoritative statement of what Trama is. [`NON-GOALS.md`](NON-GOALS.md) says what it is not. The original long-form write-up is kept as historical background in [`docs/vision-detailed.md`](docs/vision-detailed.md); it predates the current model, and where the two disagree, this file wins.

## The problem

Project-management tools often make people group work into a second unit of execution. With coding agents, that can duplicate status and add administration instead of helping the work.

- Tasks should remain granular, even when one agent session works across several of them.
- An agent (often with subagents) does a large share of the typing, so the bottleneck moves from execution to **coordination**: who reviews, who is blocked on what.
- The reason behind a choice lives in a chat thread nobody will find in a month.
- An agent that finishes a change needs a place to show what it produced.

The Task is both the report of a problem and the place to coordinate its response. Its description explains the problem and context.

## Who it is for

Small to mid-sized software teams where coding agents already write a meaningful part of the code, and where someone is accountable for what ships. They probably already have a tracker (Linear, Jira, GitHub Issues) and an execution environment (an agent tool, an IDE, Git hosting). They do not want another place to re-type what those tools already know.

## The core model

Tasks are the unit of work. Optional details appear when they help.

| Object | Answers | Notes |
|---|---|---|
| **Task** | What problem exists? | The unit of work. The description explains the problem and context. Tasks can have sub-tasks with their own status. |
| **Artifact** | What did the work produce? | Pull requests, builds, deployments, with live CI and review state. |
| **Comment** | What was found, asked or concluded along the way? | Short factual notes on a task, project or artifact. |
| **Attention** | Where is a person needed right now? | A queue derived from the work: reviews, failing CI, conflicts, triage. It never creates a parallel status. |

A **Project** groups tasks with milestones. It optionally points at one Git repository (`owner/name` or a URL), which is how a checkout finds its project. Projects provide planning context; they do not create another execution unit.

```text
Task (problem + context)
  ├── Sub-tasks
  ├── Comments
  └── Artifacts
       └── Attention surfaces where a person is needed
```

## Principles

1. **Delta-first, not Delta-dependent.** Trama should work well with Delta while remaining useful with other agents and tools.
2. **Do not duplicate execution.** Transcripts, prompts, tool calls, and file edits belong to the execution tool. Trama links to that context and keeps only what helps the next person continue.
3. **One status, one source of truth.** Task status is the work status. Attention feeds on it; it does not create a parallel status lifecycle.
4. **Automation over administration.** Use agents and integrations to reduce manual entry, not to create more fields to maintain.
5. **Optional complexity.** A simple Task needs only its problem; sub-tasks and a project appear when useful.
6. **Self-hostable and boring.** One Postgres, a few small services, server-side secrets, authorization enforced on the server.

## What makes it different

**From Linear and Jira.** Trama stays task-first while making it easy for agents to pick up work, report factual progress and attach what they produced, without adding a second execution object.

**From agent tools and IDEs.** They own execution and its history. Trama owns what a *team* needs to know about that execution without opening it.

**From wikis and chat.** Context lives on the work itself, as comments and artifacts with state, and surfaces in the queue of the person who must act.

## How humans and agents work together

1. Tasks arrive from people, monitoring, imports or agents.
2. A Task describes the problem and context.
3. Agents work from one or more Tasks through MCP, the CLI or the API, using the Task context.
4. Agents record factual progress, comments and artifacts on the Task.
5. Anything that needs a person (a review, failing CI, a conflict) appears in Attention.
6. Artifacts and linked execution context show what the work produced. Task status remains the single work status.

## What success looks like

A person or agent returning to a Task can quickly learn the problem, desired result, what has been tried, and what has been produced.

Trama fails if it becomes another place everyone must update by hand, if it copies what execution tools already hold, or if it drifts into a general-purpose project-management suite that competes with trackers on features. The scope is held by the decision test below and recorded in [`NON-GOALS.md`](NON-GOALS.md).

**The decision test for any new feature:** does it help someone develop better, or does it mainly help them administer development? Prefer durable context that transfers between Tasks, agents, and sessions; otherwise link to the tool that already holds it.
