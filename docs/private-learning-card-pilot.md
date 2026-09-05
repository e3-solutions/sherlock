# Private learning-card pilot

## Why this exists

Useful engineering knowledge is already present in work sessions, pull
requests, CI, reviews, issues, and decisions. It is scattered and difficult to
rediscover. This pilot turns a small number of well-evidenced lessons into
private, human-reviewed learning cards.

It is not a session archive, a publishing system, or an automatic summary
engine. It does not copy raw sessions into cards.

## The bounded flow

```text
candidate pointers
    -> private card draft
    -> contract + evidence checks
    -> local human review
    -> accepted private card
    -> observed reuse on later work
    -> aggregate pilot result
```

1. A person (or a bounded discovery step) supplies pointers to possible
   evidence, such as an issue, PR, commit, CI run, or review. Raw recordings,
   transcripts, prompts, customer information, and storage links stay out.
2. The author creates one private draft with six fields: problem, learning,
   attempts and result, reuse conditions, confidence, and evidence references.
3. Local checks reject incomplete cards, public visibility, raw-content fields,
   unsupported evidence, and high-confidence claims lacking direct independent
   outcome proof.
4. A human approves, rejects, or asks for more evidence. Only approved cards may
   be considered for reuse.
5. When an engineer actually sees a card before or during later work, a tiny
   private reuse record captures a constrained effect and links the later work
   item. The record must not claim time saved.
6. The local summary counts reviewed cards and reference-backed helpful reuse.
   It explicitly reports observations rather than claiming causation.

## What would prove this pilot is worth continuing?

The first pilot should use three to five real cards in one narrow area. It is
promising only if all of these hold:

- reviewers accept cards because their evidence and wording are genuinely
  reusable, not because a quota exists;
- a later engineer reports one or more useful cards **before or during** a
  comparable work item and gives that work item a reference;
- the recorded effect is concrete: avoiding a repeat investigation, avoiding a
  known failure, or informing a design choice;
- no privacy or provenance check is bypassed.

That is evidence of usefulness, not proof of time saved. A larger rollout
should be considered only after this initial observation is positive. To test a
time-saving claim later, use a deliberately designed comparison rather than
inferring it from card views.

## Local-only boundary

The `sherlock_learning_cards` package is intentionally pure and has no network
or publishing capability. Its contracts allow `visibility: private` only. A
future sharing or Forum decision needs separate, explicit approval and is out
of scope for this pilot.

## Local workflow

The package exposes one local command, `learning-card`. It performs no network
activity. The normal sequence is:

1. `create` takes a narrow candidate JSON object containing only the seven card
   content fields and creates an owner-only private draft.
2. `validate` checks the draft; `brief` emits the bounded review fields.
3. `pack` turns an explicit JSON list of drafts into an owner-only static HTML
   review page. The page has no save or submit action.
4. `record-review` creates a separate owner-only receipt. It binds the review
   to the exact canonical card hash.
5. `finalize` creates a reviewed card only for an approved, matching receipt.
   Rejected and needs-evidence receipts intentionally leave the draft unchanged.
6. `pilot-summary` checks a private reuse-measurement file against the supplied
   valid cards and creates an owner-only aggregate result.

Every output is new-file-only and owner-readable, so a later command cannot
silently replace a draft, a receipt, a review pack, or a result.
