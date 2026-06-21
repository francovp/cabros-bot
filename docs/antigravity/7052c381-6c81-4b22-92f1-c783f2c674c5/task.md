# Checklist - Feature 4: Combined Analysis Upgrade

- [x] Expose `callCombinedAnalysis` in `TradingViewMcpService.js` and support `analysisMode` routing in `analyzeSymbolIdentifier`
- [x] Add `analysisMode` request validation/defaults to `parseExpandedAnalysisAlertRequest` in `expandedAnalysisAlertReport.js`
- [x] Update `buildReportRow` to extract indicators from nested `analysis.technical` (from `combined_analysis` response)
- [x] Extend formatting in `expandedAnalysisAlertReport.js` to output Reddit sentiment, confluence recommendation, and RSS headlines in Spanish
- [x] Update the controller `expandedAnalysisAlert.js` to forward `analysisMode`
- [x] Add unit and integration tests for validation, formatting, and endpoint execution
- [x] Verify everything works and run tests
