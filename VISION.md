# Trama Vision

> **Issues describe demand. Workstreams deliver outcomes. Decisions and artifacts are the proof. Humans are pulled in only where they are needed.**

This is the authoritative statement of what Trama is. [`NON-GOALS.md`](NON-GOALS.md) says what it is not. The original long-form write-up is kept as background in [`docs/vision-detailed.md`](docs/vision-detailed.md); where the two disagree, this file wins.

## The problem

Issue trackers assume that the ticket is both the unit of demand and the unit of execution: one issue, one assignee, one branch, one pull request. Work with coding agents does not look like that anymore.

- Several issues share one root cause and should be solved together.
- An agent (often with subagents) does a large share of the typing, so the bottleneck moves from execution to **coordination**: who decides, who reviews, who is blocked on what.
- A change spans several repositories and teams.
- The reason behind a choice lives in a chat thread nobody will find in a month.
- An agent that hits an ambiguity either guesses or stalls silently.

The ticket is still the right way to *report* a problem. It is the wrong place to *run* the response to it.

## Who it is for

Small to mid-sized software teams where coding agents already write a meaningful part of the code, and where someone is accountable for what ships. They probably already have a tracker (Linear, Jira, GitHub Issues) and an execution environment (an agent tool, an IDE, Git hosting). They do not want another place to re-type what those tools already know.

## The core model

Five objects carry the product. Everything else is supporting detail.

| Object | Answers | Notes |
|---|---|---|
| **Issue** | What problem or request exists? | Demand. Bug, feature, incident, tech debt, feedback. Familiar and deliberately unremarkable. |
| **Workstream** | What outcome are we pursuing? | A coordinated effort that groups the issues sharing a root cause. Has acceptance criteria, an accountable human, contributors (humans and agents), dependencies. |
| **Decision** | Why did we choose this? | A durable record (proposed, accepted, superseded, rejected) kept next to the work. Agents may propose; a human accepts. |
| **Artifact** | What did the work produce? | Pull requests, builds, documents (a link, or a Trama document for the spec or plan that lives in no repository), deployments, with live CI and review state. This is the proof of delivery. |
| **Input request / Attention** | Where is a human needed right now? | A blocked agent asks a person instead of guessing; the attention queue lists reviews, decisions, failing CI and open questions. Human attention is the scarce resource. |

Projects sit above workstreams for planning (goals, milestones, updates); repositories and teams give context. They support the five objects and must not compete with them.

```text
Issues (demand)  ->  Workstream (outcome)  ->  Decisions + Artifacts (proof)
                            ^                          |
                            +---- Input requests / Attention (humans) ----+
```

## Principles

1. **Delta-first, not Delta-dependent.** Trama works best with a shared agent workspace such as Delta, and a workstream can link to one. But the core model must stand on its own: human-only workstreams, other agent tools, and other providers are all first-class.
2. **Trama does not duplicate execution.** Transcripts, prompts, tool calls, file edits and subagent trees belong to the tool that ran them. Trama links to that context (Open in ...) and stores only what outlives the session: objective, decisions, artifacts, state. If using Trama feels like "I already did this elsewhere and now I must document it again", the feature is wrong.
3. **Status is derived from facts, not dragged.** A workstream's status comes from criteria met, PR and CI state, open questions, proposed decisions and dependencies. It can be pinned manually, but the default is the truth the evidence supports. No invented progress percentages.
4. **Agents are actors, not assignees.** Agents are members with scoped tokens, usage caps and an auditable trail. They contribute, propose decisions and ask questions. Accountability for an outcome always rests on a human.
5. **Incremental adoption next to existing trackers.** A team should get value without migrating everything: start with workstreams, keep the existing issue tracker, link what already exists. Trama can also run as the issue tracker, but must never require it. (Linking external trackers is a stated direction that is not built yet.)
6. **Few concepts, no ceremony.** A trivial issue needs no workstream. Creating a workstream is lightweight. Complexity appears only when it earns its place.
7. **Self-hostable and boring.** One Postgres, a few small services, server-side secrets, authorization enforced on the server.

## What makes it different

**From Linear and Jira.** They organize around the ticket and add agents as another kind of assignee. Trama organizes around the *outcome* and treats agents as actors who need coordination: a place to say "this is blocked on a human", a record of why a choice was made, and a status that follows evidence rather than whoever last moved a card. Trama does not try to out-feature them as an issue tracker; it is the layer above one.

**From agent tools and IDEs.** They own execution and its history. Trama owns what a *team* needs to know about that execution without opening it.

**From wikis and chat.** Decisions and open questions are structured objects with state, attached to the work, and visible in the queue of the person who must answer.

## How humans and agents work together

1. Issues arrive from people, customers, monitoring, or agents.
2. A human (or an agent proposing for human approval) groups related issues into a **workstream** with an objective and acceptance criteria, and names who is accountable.
3. Agents pick up the workstream through MCP, the CLI or the API, read a briefing of its context, and work in their own environment.
4. As they work they attach **artifacts** (PRs, builds) and report facts: criterion met, tests passing. They never set the status; it is derived.
5. When an agent needs a choice only a person can make, it opens an **input request**. It shows up in that person's **attention** queue; the answer unblocks the agent.
6. Lasting choices are recorded as **decisions**. Agents propose; a human accepts.
7. When criteria are met and artifacts are merged and deployed, the workstream is `shipped`, derived from the same evidence a reviewer would check.

## What success looks like

A person who never saw the work can open a workstream and, in seconds, learn what we are trying to achieve, which problems it covers, who is accountable, what was decided and why, what was produced, and whether it was delivered. And the people who are needed can find out, without being chased, that they are needed.

Trama fails if it becomes another place everyone must update by hand, if it copies what execution tools already hold, or if it drifts into a general-purpose project-management suite that competes with trackers on features. The scope is held by the decision test below and recorded in [`NON-GOALS.md`](NON-GOALS.md).

**The decision test for any new feature:** does it help a team coordinate an *outcome* between humans and agents (demand, workstream, decision, artifact, human attention)? Is the information durable beyond one session, and not already held by another tool? If not, link to the tool that has it, or do not build it.
