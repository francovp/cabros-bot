# Progress and Blocker Decision Policy

Use current evidence, not a historical label, to decide whether work is blocked. Record the PR head SHA and the specific failed gate. This policy narrows `GLOBAL_BLOCKED` and `NEEDS_USER`; it never waives required CI, branch protection, review findings, or safety decisions.

| Signal | Action | Outcome |
| --- | --- | --- |
| WhatsApp key absent, webhook unreachable, or delivery unconfirmed | Record the delivery state, post the actionable handoff on GitHub if possible, and continue the issue/PR workflow. Do not expose secrets or repeat indefinitely. | Underlying work outcome; notification `failed` or `not attempted` |
| `NEEDS_USER` label, but the owner answered or a safe reversible choice meets the written criteria | Record the decision and evidence, clear the stale label, then continue. | Underlying work outcome |
| Real unresolved product authority, security contract, order execution, money, or irreversible data decision | State the concrete question and recommended answer, hand off on GitHub, release any owned claim. | `NEEDS_USER` or `IN_REVIEW` for an existing PR |
| Claim helper fails, GitHub still permits reads/writes, and no fresh foreign claim exists | Continue sequentially without a claim. Recheck the issue, linked PRs, and claim comments before every consequential write. Disclose the unclaimed mode. | Underlying work outcome, ownership `unclaimed` |
| Fresh foreign claim or no authenticated GitHub read/write path | Do not write to the item. | `CLAIMED` or `GLOBAL_BLOCKED`, respectively |
| Preview absent, 502, stale, or SHA unverifiable after one bounded recovery; every other merge gate passes | Record preview as `unverified`, clear deployment-only blocker labels, and merge when confident. Verify production after merge if available. | `SHIPPED`; production verification reported separately |
| Preview fails alongside failed CI, dirty merge, unresolved review, or required operator configuration | Fix or hand off the real independent gate. Do not use preview exception. | Gate-specific outcome with exact evidence |

In unclaimed mode, do not start parallel work on that item or remove another session's `agent-working` label. Read issue/PR state immediately before a branch push, PR edit, review request, label change, or merge. Existing PR reuse and duplicate checks still apply. If the claim helper recovers, acquire and verify the claim before continuing; if a foreign claim appears, stop writes.

Preview exception proof is a compact gate record: PR head SHA; current local test and smoke results for that head; required CI statuses; mergeability and branch protection; issue criteria; paginated review threads and top-level comments; quiet-window result; preview URL, attempted recovery, and why exact-head preview is unavailable. `401/403` on a protected endpoint can establish liveness but cannot establish behavior or served SHA. Do not describe an unverified deployment as passed.

Recent examples: [issue #626](https://github.com/francovp/cabros-bot/issues/626) had preview 502 **plus** failed CI, conflicts, and open review threads, so it was not preview-only. [issue #655](https://github.com/francovp/cabros-bot/issues/655) had a 502 and an unresolved scope thread. For [issue #805](https://github.com/francovp/cabros-bot/issues/805), choose a conservative retention policy that preserves durable duplicate prevention and keeps live order execution gated; stop only if no such choice satisfies the issue's criteria. [issue #709](https://github.com/francovp/cabros-bot/issues/709) recorded an undelivered WhatsApp attempt; that delivery failure is not itself a reason to stop other work.
