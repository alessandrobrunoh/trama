---
name: trama-ask-and-decide
description: Use an Issue's Human input feature when a person must answer a question or record a durable decision. Question and Decision are distinct modes with distinct lifecycles.
---

# Human input on an Issue

Use the Issue's Human input feature for person-dependent input. It has two modes, **Question** and **Decision**. Choose the mode that matches the intent; do not treat them as interchangeable.

## Question mode: get an answer

Create a Question when implementation depends on a person's answer: product intent, scope, a trade-off, approval, or missing information. Do not ask about facts you can look up.

Write one clear, answerable question and include decision-relevant context. Offer a small set of mutually exclusive options when helpful. Assign it to a person only when appropriate.

Lifecycle: create the Question on its primary Issue, wait for a human answer, then read and apply that answer. Do not answer your own question, mark it resolved, or silently dismiss it. Continue independent work on other issues.

## Decision mode: record a durable conclusion

Create a Decision when a choice should remain useful beyond the current conversation: for example, an architecture or data-model choice, a security trade-off, or a rejected alternative future contributors may revisit. State the rule/conclusion and rationale; include relevant alternatives. A Decision must have one primary Issue and may reference related Issues.

Lifecycle: create or propose the Decision on its primary Issue. A human, not the agent, accepts, rejects, or supersedes it. Never represent a proposal as accepted, and do not edit an accepted Decision to change its meaning; create a new Decision that explains the relationship.

## Choosing a mode

| Situation | Mode |
|---|---|
| “Which option should I use?” | Question |
| “We chose X because Y,” and it should persist | Decision |
| A lasting choice needs human approval | Decision, with the approval needed stated clearly |
| Small, reversible implementation detail | Neither; summarize in the code review or issue update |

Use `ask_human` for Question mode and `record_decision` for Decision mode when those tools are available. Use the current MCP capability or CLI schema for exact arguments and other read/update operations; do not assume parameter names or lifecycle transitions from older tooling. Keep the complete conversation transcript in execution tools, not Trama.
