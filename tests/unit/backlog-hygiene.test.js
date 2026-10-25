const {
	calculateSimilarity,
	determineStatusLabel,
	findDuplicates,
	findStaleAgentWorking,
	fetchSentryEventCount,
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
			});

			expect(report).toContain('# Backlog Hygiene Report');
			expect(report).toContain('status/ready: 5');
			expect(report).toContain('status/in-progress: 2');
			expect(report).toContain('Possible duplicate of #101');
			expect(report).toContain('#501');
			expect(report).toContain('#601');
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
	});
});
