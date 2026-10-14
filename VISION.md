# Trama Vision

> **Issues describe problems and goals. Plans, human input, and artifacts preserve what helps the work continue.**

This is the authoritative statement of what Trama is. [`NON-GOALS.md`](NON-GOALS.md) says what it is not. The original long-form write-up is kept as background in [`docs/vision-detailed.md`](docs/vision-detailed.md); where the two disagree, this file wins.

## The problem

Project-management tools often make people group Issues into a second unit of work. With coding agents, that can duplicate status and add administration instead of helping the work.

- Issues should remain granular, even when one agent session works across several of them.
- An agent (often with subagents) does a large share of the typing, so the bottleneck moves from execution to **coordination**: who decides, who reviews, who is blocked on what.
- A change spans several repositories and teams.
- The reason behind a choice lives in a chat thread nobody will find in a month.
- An agent that hits an ambiguity either guesses or stalls silently.

The Issue is both the report of a problem and the place to coordinate its response. Its description explains the problem and context; its optional Goal says what should be true when resolved.

## Who it is for

Small to mid-sized software teams where coding agents already write a meaningful part of the code, and where someone is accountable for what ships. They probably already have a tracker (Linear, Jira, GitHub Issues) and an execution environment (an agent tool, an IDE, Git hosting). They do not want another place to re-type what those tools already know.

## The core model

Issues are the unit of work. Optional details appear when they help.

| Object | Answers | Notes |
|---|---|---|
| **Issue** | What problem exists, and what should be true when it is resolved? | The unit of work. Its Goal is optional; the description explains the problem and context. |
| **Plan** | How might we approach the work? | Optional, created near implementation, and linked to its Issue. |
| **Human input** | What does an agent need from a person? | One Issue-level feature with two modes: a Question or a durable Decision. |
| **Artifact** | What did the work produce? | Pull requests, builds, documents, deployments, with live CI and review state. |

Projects, repositories and teams provide optional context; they do not create another execution unit.

```text
Issue (problem + Goal)
  ├── Plan (optional)
  ├── Human input: Question | Decision
  └── Artifacts
       └── Attention surfaces where a person is needed
```

## Principles

1. **Delta-first, not Delta-dependent.** Trama should work well with Delta while remaining useful with other agents and tools.
2. **Do not duplicate execution.** Transcripts, prompts, tool calls, and file edits belong to the execution tool. Trama links to that context and keeps only what helps the next person continue.
3. **One status, one source of truth.** Issue status is the work status. Human input feeds Attention; it does not create a parallel status lifecycle.
4. **Human decisions survive agent sessions.** A meaningful choice and its rationale remain attached to the Issue after the chat ends.
5. **Automation over administration.** Use agents and integrations to reduce manual entry, not to create more fields to maintain.
6. **Optional complexity.** A simple Issue needs only its problem; Goal, Plan, Questions and Decisions appear when useful.
7. **Self-hostable and boring.** One Postgres, a few small services, server-side secrets, authorization enforced on the server.

## What makes it different

**From Linear and Jira.** Trama stays issue-first while making it easy for agents to preserve goals, plans, questions, and decisions without adding a second execution object.

**From agent tools and IDEs.** They own execution and its history. Trama owns what a *team* needs to know about that execution without opening it.

**From wikis and chat.** Decisions and open questions are structured objects with state, attached to the work, and visible in the queue of the person who must answer.

## How humans and agents work together

1. Issues arrive from people, customers, monitoring, or agents.
2. An Issue describes the problem and context; an optional Goal states the desired result.
3. Near implementation, a human or agent can add a Plan to the Issue.
4. Agents work from one or more Issues through MCP, the CLI or the API, using the Issue context.
5. An agent can ask a **Question** when it needs information, or propose a **Decision** when a durable choice is needed. Both appear in Attention.
6. Artifacts and linked execution context show what the work produced. Issue status remains the single work status.

## What success looks like

A person or agent returning to an Issue can quickly learn the problem, desired result, current Plan, meaningful decisions, open questions, and what has been produced.

Trama fails if it becomes another place everyone must update by hand, if it copies what execution tools already hold, or if it drifts into a general-purpose project-management suite that competes with trackers on features. The scope is held by the decision test below and recorded in [`NON-GOALS.md`](NON-GOALS.md).

**The decision test for any new feature:** does it help someone develop better, or does it mainly help them administer development? Prefer durable context that transfers between Issues, agents, and sessions; otherwise link to the tool that already holds it.
