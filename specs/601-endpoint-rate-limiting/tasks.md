# Tasks: Per-Endpoint Rate Limiting

**Input**: [spec.md](spec.md) and [plan.md](plan.md)
**Prerequisites**: Feature requirements and implementation plan complete.

## Implementation and Verification

- [x] T001 Inspect current limiter behavior, endpoint mounts, identity key, error envelope, and existing ingest burst allowance.
- [x] T002 Add regression assertions for missing OpenAPI headers, missing Postman headers, and runtime error-text drift; verify they fail before updating the contract.
- [x] T003 Add dedicated endpoint tiers while preserving the existing global and webhook-ingest buckets.
- [x] T004 Document tier variables and explicitly exclude these security controls from Remote Config.
- [x] T005 Add 429 response references, headers, and matching saved examples to OpenAPI and Postman.
- [x] T006 Re-run the focused limiter, contract, Postman, integration, and documentation-alignment suites on the final tree (6 suites, 231 tests passed).
- [x] T007 Run the full Jest suite on the final tree and classify failures: 305/307 suites and 7,397/7,399 tests passed; `news-monitor-cache` returned 400 instead of 200 and `alerts-endpoint` returned 400 instead of 401. Neither failing test file is changed by this PR; both failures also appeared in an earlier isolated rerun.
- [ ] T008 Push the updated branch, verify exact-head CI and OpenClaw preview/E2E, resolve applicable PR discussions, and merge only when all gates pass.

## Dependencies

- T001 precedes T002-T005.
- T006 validates the local implementation before T007.
- T008 depends on T007 and current deployment/CI/review evidence.
