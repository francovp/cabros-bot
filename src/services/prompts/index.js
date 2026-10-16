const {
	REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS,
	REQUIRED_ALERT_ENRICHMENT_CALIBRATION_GUIDANCE,
	inspectAlertEnrichmentRiskSchema,
	PromptKeys,
	PROMPT_DEFINITIONS,
	PromptService,
	getPromptService,
	resetPromptServiceForTests,
} = require('./PromptService');
const { probePromptReadiness } = require('./promptReadiness');

/**
 * Resolve every registered prompt once so `/api/status` can report a proven
 * verdict shortly after boot instead of `unverified` until real traffic arrives.
 *
 * The probe is what makes this enablement verifiable: the dominant failure mode is
 * credentials that are valid but a `production` label that was never published,
 * which makes every fetch fall back to the local file and would otherwise look
 * healthy forever. Fail-open and bounded, and a no-op when the gate is off.
 * Returns false when it did not run, so callers need no gate check of their own.
 */
async function probeManagedPromptReadiness({ promptService = getPromptService() } = {}) {
	if (typeof promptService?.resolvePrompt !== 'function') {
		return false;
	}

	return probePromptReadiness({
		promptNames: Object.keys(PROMPT_DEFINITIONS),
		// Per prompt, not per sweep: one unbuildable local fallback must not abort
		// the remaining probes, and remote errors are already recorded inside
		// `resolveRemotePrompt` before they reach here.
		resolver: async (promptName) => {
			try {
				await promptService.resolvePrompt(promptName, {}, { dryRun: true });
			} catch (error) {
				console.warn(`[prompts] Readiness probe could not resolve "${promptName}":`, error && error.message);
			}
		},
	});
}

module.exports = {
	REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS,
	REQUIRED_ALERT_ENRICHMENT_CALIBRATION_GUIDANCE,
	inspectAlertEnrichmentRiskSchema,
	PromptKeys,
	PROMPT_DEFINITIONS,
	PromptService,
	getPromptService,
	probeManagedPromptReadiness,
	resetPromptServiceForTests,
};
