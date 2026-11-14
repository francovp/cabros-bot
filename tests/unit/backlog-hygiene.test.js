const {
	calculateSimilarity,
	determineStatusLabel,
	findDuplicates,
	findStaleAgentWorking,
	fetchSentryEventCount,
	findImplementedOnMaster,
	findSupersededDependabotPrs,
	findBotNoiseSuggestions,
	generateBacklogReport,
	parseArgs,
	runBacklogHygiene,
} = require('../../scripts/backlog-hygiene');

describe('backlog-hygiene script (scripts/backlog-hygiene.js)', () => {
	describe('parseArgs', () => {
		test('defaults to dry-run mode when no flags are passed', () => {
			const options = parseArgs([]);
			expect(options.dryRun).toBe(true);
		});

		test('parses --dry-run explicitly', () => {
			const options = parseArgs(['--dry-run']);
			expect(options.dryRun).toBe(true);
		});

		test('parses --apply to disable dry-run', () => {
			const options = parseArgs(['--apply']);
			expect(options.dryRun).toBe(false);
		});

		test('parses custom repo and report output path', () => {
			const options = parseArgs(['--repo', 'owner/repo', '--report', 'custom-report.md']);
			expect(options.repo).toBe('owner/repo');
			expect(options.reportPath).toBe('custom-report.md');
		});

		test('parses --close-verified flag', () => {
			const options = parseArgs(['--close-verified']);
			expect(options.closeVerified).toBe(true);
		});
	});

	describe('determineStatusLabel', () => {
		test('assigns status/blocked when GLOBAL_BLOCKED is present', () => {
			const issue = {
				labels: [{ name: 'GLOBAL_BLOCKED' }, { name: 'agent-working' }],
			};
			expect(determineStatusLabel(issue)).toBe('status/blocked');
		});

		test('assigns status/in-progress when agent-working is present', () => {
			const issue = {
				labels: [{ name: 'agent-working' }, { name: 'area/api' }],
			};
			expect(determineStatusLabel(issue)).toBe('status/in-progress');
		});

		test('assigns status/in-progress when In review is present and preserves it without demotion', () => {
			const issue = {
				labels: [{ name: 'In review' }, { name: 'status/triage' }],
			};
			// Must never demote In review to needs-triage
			expect(determineStatusLabel(issue)).toBe('status/in-progress');
		});

		test('assigns status/ready when status/ready or automation/ready is present', () => {
			const issue1 = { labels: [{ name: 'status/ready' }] };
			const issue2 = { labels: [{ name: 'automation/ready' }] };
			expect(determineStatusLabel(issue1)).toBe('status/ready');
			expect(determineStatusLabel(issue2)).toBe('status/ready');
		});

		test('assigns status/needs-triage by default or when status/triage is present', () => {
			const issue1 = { labels: [{ name: 'status/triage' }] };
			const issue2 = { labels: [{ name: 'area/api' }] };
			const issue3 = { labels: [] };
			expect(determineStatusLabel(issue1)).toBe('status/needs-triage');
			expect(determineStatusLabel(issue2)).toBe('status/needs-triage');
			expect(determineStatusLabel(issue3)).toBe('status/needs-triage');
		});
	});

	describe('calculateSimilarity & findDuplicates', () => {
		test('computes high similarity for issues with near-identical titles and overlapping labels', () => {
			const issueA = {
				number: 101,
				title: 'Fix Redis timeout during TradingView MCP scan',
				body: 'Redis times out when running heavy scan operations on TradingView MCP.',
				labels: [{ name: 'area/trading' }, { name: 'area/observability' }],
			};
			const issueB = {
				number: 102,
				title: 'Fix Redis timeout when executing TradingView MCP scan',
				body: 'TradingView MCP scan fails with Redis timeout error.',
				labels: [{ name: 'area/trading' }, { name: 'type/bug' }],
			};

			const similarity = calculateSimilarity(issueA, issueB);
			expect(similarity).toBeGreaterThan(0.7);
		});

		test('computes low similarity for completely unrelated issues', () => {
			const issueA = {
				number: 101,
				title: 'Fix Redis timeout during TradingView MCP scan',
				body: 'Redis times out during TradingView MCP scan.',
				labels: [{ name: 'area/trading' }],
			};
			const issueB = {
				number: 103,
				title: 'Add WhatsApp template for admin notification',
				body: 'WhatsApp service should send template message on alert failure.',
				labels: [{ name: 'area/whatsapp' }],
			};

			const similarity = calculateSimilarity(issueA, issueB);
			expect(similarity).toBeLessThan(0.3);
		});

		test('findDuplicates identifies pairs above threshold > 0.7 and ignores already commented issues', () => {
			const openIssues = [
				{
					number: 201,
					title: 'Make signal outcome evaluation windows configurable via Remote Config',
					body: 'Signal outcome evaluation windows should be configurable via Remote Config.',
					labels: [{ name: 'area/trading' }, { name: 'priority/2-qol' }],
					comments: [],
				},
				{
					number: 202,
					title: 'Configure signal outcome evaluation windows in Remote Config template',
					body: 'Remote config template should support configuring signal outcome evaluation windows.',
					labels: [{ name: 'area/trading' }, { name: 'priority/2-qol' }],
					comments: [],
				},
				{
					number: 203,
					title: 'Add WhatsApp message delivery tracking metrics',
					body: 'WhatsApp metrics for delivery status.',
					labels: [{ name: 'area/whatsapp' }],
					comments: [],
				},
			];

			const duplicates = findDuplicates(openIssues, [], { threshold: 0.7 });
			expect(duplicates.length).toBe(1);
			expect(duplicates[0].targetIssueNumber).toBe(202);
			expect(duplicates[0].duplicateOfNumber).toBe(201);
			expect(duplicates[0].score).toBeGreaterThan(0.7);
		});

		test('skips duplicate flagging if a duplicate-of comment was posted in the last 30 days', () => {
			const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
			const openIssues = [
				{
					number: 301,
					title: 'Make signal outcome evaluation windows configurable',
					body: 'Evaluation windows configuration.',
					labels: [{ name: 'area/trading' }],
					comments: [],
				},
				{
					number: 302,
					title: 'Make signal outcome evaluation windows configurable',
					body: 'Evaluation windows configuration.',
					labels: [{ name: 'area/trading' }],
					comments: [
						{
							body: 'Possible duplicate of #301 (similarity score: 0.95)',
							createdAt: recentDate,
						},
					],
				},
			];

			const duplicates = findDuplicates(openIssues, [], { threshold: 0.7 });
			expect(duplicates.length).toBe(0);
		});
	});

	describe('findStaleAgentWorking', () => {
		test('identifies issues labeled agent-working for >14 days with no recent commits or PRs', () => {
			const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
			const issues = [
				{
					number: 401,
					title: 'Unfinished old feature',
					labels: [{ name: 'agent-working' }],
					updatedAt: twentyDaysAgo,
					hasReferencingPr: false,
					hasReferencingCommit: false,
				},
				{
					number: 402,
					title: 'Active feature with recent activity',
					labels: [{ name: 'agent-working' }],
					updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
					hasReferencingPr: true,
					hasReferencingCommit: false,
				},
			];

			const stale = findStaleAgentWorking(issues, { staleDays: 14 });
			expect(stale.length).toBe(1);
			expect(stale[0].number).toBe(401);
		});

		test('ignores issues that already carry stale/agent-working label', () => {
			const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
			const issues = [
				{
					number: 403,
					title: 'Already flagged stale task',
					labels: [{ name: 'agent-working' }, { name: 'stale/agent-working' }],
					updatedAt: twentyDaysAgo,
					hasReferencingPr: false,
					hasReferencingCommit: false,
				},
			];

			const stale = findStaleAgentWorking(issues, { staleDays: 14 });
			expect(stale.length).toBe(0);
		});
	});

	describe('fetchSentryEventCount (production evidence appender)', () => {
		test('returns null and skips silently when SENTRY_AUTH_TOKEN is not provided', async () => {
			const count = await fetchSentryEventCount('some-tag', { token: '' });
			expect(count).toBeNull();
		});

		test('returns event count when SENTRY_AUTH_TOKEN is provided and fetch succeeds', async () => {
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => [{ count: 42 }],
			});
			const count = await fetchSentryEventCount('issue-tag', {
				token: 'sntrys_mock_token',
				fetchFn: mockFetch,
			});
			expect(count).toBe(42);
		});

		test('returns null fail-open when Sentry fetch throws or fails', async () => {
			const mockFetch = jest.fn().mockRejectedValue(new Error('Sentry network timeout'));
			const count = await fetchSentryEventCount('issue-tag', {
				token: 'sntrys_mock_token',
				fetchFn: mockFetch,
			});
			expect(count).toBeNull();
		});
	});

	describe('findImplementedOnMaster', () => {
		test('identifies issues and PRs mentioned in git commit log by #number or GH-number', () => {
			const items = [
				{ number: 1338, title: 'CI pnpm version conflict' },
				{ number: 859, title: 'Request deadline middleware' },
				{ number: 9999, title: 'Unrelated still open issue' },
				{ number: 1106, title: 'Burst aggregator', isPr: true },
			];
			const commitLogs = [
				'4fd9e0001 ci: align workflows to single pnpm version source (#1472) closes #1338',
				'994a52af feat: add request deadline middleware (GH-859)',
				'cca996a7 feat(alerts): aggregate same-direction alert bursts (#1104) (#1362) closes #1106',
			];

			const result = findImplementedOnMaster(items, { commitLogs });
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.number)).toEqual([1338, 859, 1106]);
			expect(result.find((r) => r.number === 1106).type).toBe('pr');
			expect(result.find((r) => r.number === 1338).type).toBe('issue');
		});

		test('returns empty array when no items match commit logs', () => {
			const items = [{ number: 9999, title: 'Open issue' }];
			const commitLogs = ['abcdef1 feat: unrelated commit (#1234)'];
			const result = findImplementedOnMaster(items, { commitLogs });
			expect(result).toEqual([]);
		});
	});

	describe('findSupersededDependabotPrs', () => {
		test('flags older Dependabot PRs when newer open PR bumps the same dependency', () => {
			const openPrs = [
				{
					number: 518,
					headRefName: 'dependabot/npm_and_yarn/prettier-3.9.6',
					title: 'build(deps-dev): bump prettier from 3.8.3 to 3.9.6',
				},
				{
					number: 1196,
					headRefName: 'dependabot/npm_and_yarn/prettier-3.9.9',
					title: 'chore(deps-dev): bump prettier from 3.8.3 to 3.9.9',
				},
				{
					number: 999,
					headRefName: 'feature/unrelated',
					title: 'feat: regular PR',
				},
			];

			const superseded = findSupersededDependabotPrs(openPrs, { enforceShaPinning: false });
			expect(superseded).toHaveLength(1);
			expect(superseded[0].number).toBe(518);
			expect(superseded[0].reason).toContain('Superseded by newer open PR #1196');
		});

		test('flags tag-based GitHub Action bumps when 40-char SHA pinning policy is enforced', () => {
			const openPrs = [
				{
					number: 1206,
					headRefName: 'dependabot/github_actions/actions/cache-6',
					title: 'build(deps): bump actions/cache from 4.3.0 to 6.1.0',
				},
			];

			const superseded = findSupersededDependabotPrs(openPrs, { enforceShaPinning: true });
			expect(superseded).toHaveLength(1);
			expect(superseded[0].number).toBe(1206);
			expect(superseded[0].reason).toContain('40-char commit SHA');
		});
	});

	describe('findBotNoiseSuggestions', () => {
		test('flags virgin-trainee bot greeting comments', () => {
			const issues = [
				{
					number: 1486,
					title: "Unaddressed suggestion: Hello! I'm the Virgin Trainee bot...",
					body: "<!-- source-suggestion-id=6470870748 -->\nHello! I'm the Virgin Trainee bot. I've noticed this updated PR...",
				},
				{
					number: 1485,
					title: 'Unaddressed suggestion: Hi @francovp and @gigachad-senior-dev!',
					body: '<!-- source-suggestion-id=6460162250 -->\nHi @francovp and @gigachad-senior-dev! 🤖 This PR looks super cool...',
				},
			];

			const noise = findBotNoiseSuggestions(issues);
			expect(noise).toHaveLength(2);
			expect(noise.map((n) => n.number)).toEqual([1486, 1485]);
		});

		test('flags SHIPPED merge summary issues', () => {
			const issues = [
				{
					number: 1484,
					title: 'Unaddressed suggestion: SHIPPED: PR #1480 was squash-merged',
					body: '<!-- source-suggestion-id=6458439302 -->\nSHIPPED: PR #1480 was squash-merged as 1c3cccc43...',
				},
			];

			const noise = findBotNoiseSuggestions(issues);
			expect(noise).toHaveLength(1);
			expect(noise[0].number).toBe(1484);
			expect(noise[0].reason).toContain('SHIPPED summary');
		});

		test('ignores legitimate code suggestions', () => {
			const issues = [
				{
					number: 1500,
					title: 'Unaddressed suggestion: handle Redis connection retry',
					body: '<!-- source-suggestion-id=123 -->\nConsider wrapping Redis reconnect with exponential backoff:\n```js\nconst delay = Math.min(1000 * 2 ** attempt, 30000);\n```',
				},
			];

			const noise = findBotNoiseSuggestions(issues);
			expect(noise).toHaveLength(0);
		});
	});

	describe('generateBacklogReport', () => {
		test('produces markdown report summarizing status counts, duplicates, and triage queue', () => {
			const report = generateBacklogReport({
				countsByStatus: {
					'status/ready': 5,
					'status/in-progress': 2,
					'status/blocked': 1,
					'status/needs-triage': 3,
				},
				countsByPriority: {
					'priority/1-roi': 2,
					'priority/critical': 1,
					'priority/high': 4,
				},
				duplicates: [
					{ targetIssueNumber: 102, duplicateOfNumber: 101, score: 0.85 },
				],
				staleAgentWorking: [{ number: 501, title: 'Old abandoned task' }],
				needsTriageQueue: [{ number: 601, title: 'Unlabeled feature request' }],
				implementedOnMaster: [
					{ number: 1338, type: 'issue', title: 'pnpm setup fix', matchedCommit: '4fd9e0001 (#1472)' },
				],
				supersededDependabotPrs: [
					{ number: 518, title: 'bump prettier', reason: 'Superseded by PR #1196' },
				],
				botNoiseSuggestions: [
					{ number: 1486, title: 'Virgin trainee greeting', reason: 'Bot greeting' },
				],
			});

			expect(report).toContain('# Backlog Hygiene Report');
			expect(report).toContain('status/ready: 5');
			expect(report).toContain('status/in-progress: 2');
			expect(report).toContain('Possible duplicate of #101');
			expect(report).toContain('#501');
			expect(report).toContain('#601');
			expect(report).toContain('## Implemented on `master` (Ready to Close)');
			expect(report).toContain('#1338 (issue)');
			expect(report).toContain('## Superseded Dependabot PRs');
			expect(report).toContain('PR #518');
			expect(report).toContain('## Bot Noise / Unactionable Suggestions');
			expect(report).toContain('#1486');
		});
	});

	describe('runBacklogHygiene', () => {
		test('executes in dry-run mode without mutations', async () => {
			const mockExecGh = jest.fn((args) => {
				if (args[0] === 'auth' && args[1] === 'status') return 'Logged in';
				if (args[0] === 'issue' && args[1] === 'list' && args[3] === 'open') {
					return JSON.stringify([
						{
							number: 101,
							title: 'Sample ready issue',
							body: 'Body text',
							labels: [{ name: 'status/needs-triage' }, { name: 'automation/ready' }],
							comments: [],
							updatedAt: new Date().toISOString(),
						},
					]);
				}
				if (args[0] === 'issue' && args[1] === 'list' && args[3] === 'closed') {
					return JSON.stringify([]);
				}
				if (args[0] === 'pr' && args[1] === 'list') {
					return JSON.stringify([]);
				}
				return '';
			});

			const result = await runBacklogHygiene({
				dryRun: true,
				reportPath: '',
				execGh: mockExecGh,
			});

			expect(result.countsByStatus['status/ready']).toBe(1);
			// Verify zero mutations in dryRun
			const editCalls = mockExecGh.mock.calls.filter((c) => c[0][0] === 'issue' && (c[0][1] === 'edit' || c[0][1] === 'comment'));
			expect(editCalls.length).toBe(0);
		});

		test('executes combined label edit and appends Sentry evidence in apply mode', async () => {
			const mockExecGh = jest.fn((args) => {
				if (args[0] === 'auth' && args[1] === 'status') return 'Logged in';
				if (args[0] === 'issue' && args[1] === 'list' && args[3] === 'open') {
					return JSON.stringify([
						{
							number: 201,
							title: 'ROI opportunity task',
							body: 'Initial issue description without sentry line',
							labels: [{ name: 'priority/1-roi' }, { name: 'status/needs-triage' }, { name: 'status/ready' }],
							comments: [],
							updatedAt: new Date().toISOString(),
						},
					]);
				}
				if (args[0] === 'issue' && args[1] === 'list' && args[3] === 'closed') {
					return JSON.stringify([]);
				}
				if (args[0] === 'pr' && args[1] === 'list') {
					return JSON.stringify([]);
				}
				return '';
			});

			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => [{ count: 27 }],
			});

			const result = await runBacklogHygiene({
				dryRun: false,
				reportPath: '',
				sentryToken: 'sntrys_test_token',
				fetchFn: mockFetch,
				execGh: mockExecGh,
			});

			expect(result.sentryAppendedCount).toBe(1);

			// Check combined label update call
			const labelEditCall = mockExecGh.mock.calls.find(
				(c) => c[0][0] === 'issue' && c[0][1] === 'edit' && c[0].includes('--remove-label')
			);
			expect(labelEditCall).toBeDefined();
			expect(labelEditCall[0]).toContain('--remove-label');
			expect(labelEditCall[0]).toContain('status/needs-triage');
			expect(labelEditCall[0]).toContain('--add-label');
			expect(labelEditCall[0]).toContain('status/ready');

			// Check body edit call for Sentry evidence
			const bodyEditCall = mockExecGh.mock.calls.find(
				(c) => c[0][0] === 'issue' && c[0][1] === 'edit' && c[0].includes('--body')
			);
			expect(bodyEditCall).toBeDefined();
			const bodyArg = bodyEditCall[0][bodyEditCall[0].indexOf('--body') + 1];
			expect(bodyArg).toContain('Production: 27 events in last 30d');
		});

		test('closes verified items when closeVerified is true and dryRun is false', async () => {
			const mockExecGh = jest.fn((args) => {
				if (args[0] === 'auth' && args[1] === 'status') return 'Logged in';
				if (args[0] === 'issue' && args[1] === 'list' && args[3] === 'open') {
					return JSON.stringify([
						{
							number: 1486,
							title: "Unaddressed suggestion: Hello! I'm the Virgin Trainee bot...",
							body: "<!-- source-suggestion-id=123 -->\nHello! I'm the Virgin Trainee bot.",
							labels: [{ name: 'status/needs-triage' }],
							comments: [],
							updatedAt: new Date().toISOString(),
						},
					]);
				}
				if (args[0] === 'issue' && args[1] === 'list' && args[3] === 'closed') {
					return JSON.stringify([]);
				}
				if (args[0] === 'pr' && args[1] === 'list') {
					return JSON.stringify([
						{
							number: 1206,
							headRefName: 'dependabot/github_actions/actions/cache-6',
							title: 'build(deps): bump actions/cache from 4.3.0 to 6.1.0',
							body: '',
						},
					]);
				}
				return '';
			});

			const result = await runBacklogHygiene({
				dryRun: false,
				closeVerified: true,
				reportPath: '',
				commitLogs: ['4fd9e0001 ci: fix stuff (#1486)'],
				execGh: mockExecGh,
			});

			expect(result.closedVerifiedCount).toBeGreaterThan(0);
			const closeCalls = mockExecGh.mock.calls.filter(
				(c) => (c[0][0] === 'issue' || c[0][0] === 'pr') && c[0][1] === 'close'
			);
			expect(closeCalls.length).toBeGreaterThan(0);
		});
	});
});
