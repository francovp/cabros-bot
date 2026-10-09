## [LRN-20261006-001] correction

**Logged**: 2026-10-06T22:55:00Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
Prioritize immediate value delivery (YAGNI) over premature architectural abstractions.

### Details
In Issue #886, the trainee suggested a "unified communication layer" to abstract Telegram and WhatsApp bridges. The Senior Dev (@gigachad-senior-dev) corrected this approach, noting that while the instinct to abstract is correct for an AI Engineer, doing it *now* constitutes scope creep and violates pragmatism. 

Key points:
- Telegram and WhatsApp have fundamental API differences (Templates, session windows, media handling) that make premature abstraction a "leaky abstraction".
- Value delivery for the user (parity of 4 commands) must come first.
- Abstractions should be driven by clear signals: 3rd channel addition, >2x logic duplication, or failing integration tests.

### Suggested Action
Avoid proposing structural refactors for small feature sets. Focus on the immediate requirement, ensuring high quality (tests, logging), and only open tech-debt issues for abstractions once a concrete pattern is proven.

### Metadata
- Source: user_feedback
- Related Files: src/controllers/webhooks/handlers/whatsapp/
- Tags: YAGNI, pragmatism, architecture
- See Also: N/A
- Pattern-Key: architecture.premature_abstraction
- Recurrence-Count: 1
- First-Seen: 2026-10-06
- Last-Seen: 2026-10-06

---

## [LRN-20261009-001] correction

**Logged**: 2026-10-09T20:51:00Z
**Priority**: high
**Status**: pending
**Area**: configuration

### Summary
Verify "environment-only" flags; do not trust annotations that claim a flag is a "process-startup gate" without testing.

### Details
In Issue #721, several Firestore storage flags were documented as "environment-only" because they were believed to be startup gates. Verification (via grep/code review) proved they are re-evaluated on every call (`getFirestore()` / `isFirestoreEnabled()`), making them remotely toggleable.

Key technical takeaways:
- **Verification**: The claim that a flag is only read at startup is testable by checking if the gate function is called within the request lifecycle.
- **Remote Config Priority**: To allow disabling a feature in production that is enabled in `render.yaml`, the logic must be `remote ?? env` (Remote Config overrides environment), not `env || remote`.
- **Default Value Trap**: In the Firebase Admin SDK, a `defaultValue` in the template is reported as source `'remote'`. To avoid accidentally overriding existing production settings on first publish, use `useInAppDefault: true` for parameters that should not have a forced remote value.

### Suggested Action
Perform a first-principles check on any "environment-only" annotations in the repository. Grep for gate functions to see if they are invoked at runtime.

### Metadata
- Source: user_feedback
- Related Files: firebase-remote-config-template.json, src/services/storage/
- Tags: RemoteConfig, Firestore, first-principles
- See Also: Issue #721
- Pattern-Key: config.false_assumption_startup_gate
- Recurrence-Count: 1
- First-Seen: 2026-10-09
- Last-Seen: 2026-10-09

---
