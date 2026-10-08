---
name: trama-ask-and-decide
description: How to ask a human a question and how to record a lasting decision in Trama. Use when you are blocked, need a choice only a person can make, face an ambiguity that would change the implementation, or made a design or architecture choice other people should find later.
---

# Ask a human, and record decisions

Two tools keep humans in control without stopping you in the dark: **input requests** (questions) and **decisions** (durable conclusions).

## Input requests: when you need an answer

Open one when the right path depends on a person: scope, product intent, a trade-off, a missing credential, an approval. Not for things you can look up.

```
create_input_request {
  workstreamId,
  question: "Drop support for Safari 16, or keep the polyfill?",
  options: ["Drop it", "Keep the polyfill"],      // optional, 2–4 clear choices
  assigneeUserId                                    // optional: who should answer
}
```

Good questions are **one decision, answerable in a sentence, with the cost of each option**. Put context in the question itself ("keeping it adds ~40 kB"). Do not ask several things at once.

An open input request makes the workstream show as `needs_input` and appears in the team's attention list, so people see it. Therefore:

- Ask **once**. Check `list_input_requests` for the workstream first.
- Keep working on anything the answer does not affect; say what you are waiting on.
- Do not answer your own question. `answer_input_request` is for when a person tells you the answer and asks you to record it.
- If the answer no longer matters, tell the user; do not delete it silently (`dismiss_input_request` is for people).

## Decisions: when something should outlive the chat

Promote a choice to a decision only if it has **lasting relevance**: an architecture or data-model choice, a security trade-off, a rejected alternative future readers will propose again. Not every coding choice qualifies.

```
create_decision {
  title: "Keep the previous refresh token valid for 30 seconds",
  statement: "After rotation the previous token stays valid for 30 s.",
  rationale: "Concurrent requests may still carry the old token; invalidating immediately causes spurious logouts.",
  originWorkstreamId, relatedWorkstreamIds, tags: ["auth"],
  status: "proposed"                                // or "draft" if unfinished
}
```

Write the **statement** as a rule (what is now true) and the **rationale** as the why, including alternatives you rejected. Keep both short.

### What you may and may not do

- You **may** create (`draft`, `proposed`) and edit the content of decisions you proposed.
- You **may not** accept, reject or supersede. A proposed decision makes the workstream `needs_input` until a person decides. Tell the user the key (`ADR-23`) so they can review it.
- If a new decision replaces an old one, say so in the rationale and mention the old key; a person marks it superseded.
- Never edit an `accepted` decision to change its meaning. Propose a new one.

## Choosing between them

| Situation | Use |
|---|---|
| "Which of these should I do?" | input request |
| "I chose X because Y" and it will matter later | decision (proposed) |
| Both: you need approval for a lasting choice | create the decision, and mention it in your summary; the proposed decision already needs a person |
| Small, reversible, local choice | neither; put it in the PR description |
