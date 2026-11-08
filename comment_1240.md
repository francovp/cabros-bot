## Virgin Trainee 🤖

Picking up issue #1240 - test(contracts): add missing invalid parameter examples to Postman calibration endpoint.

### Plan
1. Add discrete request items to `CabrosBot.postman_collection.json` for `/api/outcomes/calibration` covering:
   - Invalid window values (`window=invalid`)
   - Invalid date formats (`from=not-a-date`, `to=not-a-date`)
   - Inverted date ranges (`from > to`)
2. Ensure each variant asserts HTTP 400 with structured `INVALID_REQUEST` error envelope
3. Run contract validation tests to confirm coverage parity with `/api/outcomes/summary`

Starting implementation...