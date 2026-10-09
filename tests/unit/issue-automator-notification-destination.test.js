/**
 * Contract test for issue #928 — "chore: update PR notification group".
 *
 * The skill already *names* the requested destination
 * (`120363422033474991@g.us`) and documents `NOTIFY_WHATSAPP_CHAT_ID` as the
 * configuration knob for it, but no notification payload ever read that knob:
 * every `--data-raw` body carried the destination as a hardcoded literal. The
 * documented knob was therefore dead configuration — setting
 * `NOTIFY_WHATSAPP_CHAT_ID` to another group had no effect whatsoever, and the
 * only way to move PR notifications to a different group was to edit the skill
 * file itself. That is precisely the change this issue asks for, so the
 * destination has to be resolved through the knob (defaulting to the requested
 * group) rather than duplicated into each payload.
 *
 * This test pins the contract so the destination cannot silently drift back:
 *   1. the knob is documented with the requested group as its default;
 *   2. every notification payload routes `whatsappChatId` through the knob;
 *   3. no payload carries a bare WhatsApp group literal;
 *   4. each payload still renders to valid JSON once the shell quoting is
 *      resolved — for both the default and an overridden destination;
 *   5. the override actually takes effect, which is the whole point of the
 *      issue: a different group is reachable without editing this file;
 *   6. no other WhatsApp group is presented anywhere in the skill as a
 *      notification destination;
 *   7. the markdown *structure* around every payload region is intact. The
 *      payload assertions above match bodies with a regex and never parse
 *      block structure, so an edit that reindents a payload — and silently
 *      demotes its fenced block to indented code, or promotes its list item
 *      out of the parent list — passes all six of them while GitHub renders a
 *      run-on inline blob instead of a shell block.
 *
 * Read-only: the suite only reads files, it never writes into the working tree.
 */

const { readFileSync } = require('fs');
const { join } = require('path');

const SKILL_MD = join(__dirname, '../../.agents/skills/issue-automator/SKILL.md');

/** The destination this issue asks for, and the knob's default. */
const REQUESTED_GROUP = '120363422033474991@g.us';

/**
 * The knob reference a payload must use, written with the shell quoting that
 * keeps the expanded value inside the JSON string: close the single-quoted
 * `--data-raw` argument, expand the variable in double quotes, reopen it.
 * This is the *content* of the JSON string, so `"${…}"` in a payload contains
 * it verbatim and substituting a destination leaves valid JSON behind.
 */
const KNOB_QUOTED = '\'"${NOTIFY_WHATSAPP_CHAT_ID:-' + REQUESTED_GROUP + '}"\'';

/** A literal WhatsApp destination baked straight into a payload. */
const LITERAL_DESTINATION = /"whatsappChatId":\s*"[0-9]{6,}@(g|c)\.us"/;

/** Any WhatsApp group id mentioned anywhere in the skill. */
const ANY_GROUP = /[0-9]{6,}@(?:g|c)\.us/g;

function read() {
	return readFileSync(SKILL_MD, 'utf8');
}

/**
 * Every `--data-raw '<payload>'` argument in the skill.
 *
 * The payload itself contains single quotes (`'"$VAR"'` breakouts), so the body
 * is matched as "any non-quote character, or a `'"…'` breakout group" instead of
 * naively scanning to the next quote.
 */
function notificationPayloads(text) {
	const pattern = /--data-raw '((?:[^']|(?:'"[^']*'))*)'/g;
	const payloads = [];
	let match = pattern.exec(text);
	while (match !== null) {
		const startLine = text.slice(0, match.index).split('\n').length;
		payloads.push({ body: match[1], line: startLine });
		match = pattern.exec(text);
	}
	return payloads;
}

/* ------------------------------------------------------------------ *
 * Markdown structure of the payload regions
 *
 * A payload is only executable if GitHub renders it as a fenced shell
 * block inside the list step that introduces it. Both halves are decided by
 * leading whitespace alone, which is why the assertions below pin leading
 * whitespace explicitly rather than trusting the payload regexes above.
 * ------------------------------------------------------------------ */

/** Indent width in columns, counting a tab as advancing to the next multiple of 4. */
function indentWidth(line) {
	const leading = /^[ \t]*/.exec(line)[0];
	let width = 0;
	for (const char of leading) {
		width += char === '\t' ? 4 - (width % 4) : 1;
	}
	return width;
}

const FENCE_OPEN = /^([ ]*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^([ ]*)([*+-]|\d{1,9}[.)])([ \t]+)\S/;

/** The list marker a line carries, or `null` when it is not a list item. */
function listMarkerOf(line) {
	const match = LIST_ITEM.exec(line);
	return match ? match[2] : null;
}

/** The column at which a list item's own content begins. */
function contentColumnOf(line) {
	const match = LIST_ITEM.exec(line);
	if (!match) return null;
	return match[1].length + match[2].length + match[3].replace(/\t/g, '    ').length;
}

/**
 * Mark every line that is inside (or is) a fenced code block.
 *
 * Fence content is code, not structure, so the structure scanner must skip it:
 * a `--data-raw` body at column 4 must never be mistaken for a paragraph at
 * column 4, and a closing fence must not be read as an indented paragraph that
 * closed the surrounding list item.
 */
function markFencedLines(lines) {
	const fenced = new Array(lines.length).fill(false);
	const openerOf = new Array(lines.length).fill(null);

	for (let i = 0; i < lines.length; i++) {
		const open = FENCE_OPEN.exec(lines[i]);
		if (!open) continue;

		if (openerOf[i] === null && fenced[i]) {
			// Closing fence of the block opened above.
			fenced[i] = true;
			continue;
		}

		let end = i + 1;
		while (end < lines.length && !isClosingFence(lines[end], open[2])) end++;
		for (let j = i; j <= Math.min(end, lines.length - 1); j++) fenced[j] = true;
		openerOf[i] = i;
		i = end;
	}

	return { fenced, openerOf };
}

function isClosingFence(line, openerFence) {
	const close = FENCE_OPEN.exec(line);
	if (!close) return false;
	if (close[2][0] !== openerFence[0]) return false;
	return close[2].length >= openerFence.length && close[3].trim() === '';
}

/**
 * The content column of the innermost list item that still owns `fenceIndex`,
 * or `0` when no list item does.
 *
 * An item owns a fence only when the fence is itself indented at or past the
 * item's content column and nothing between the two under-indents below it —
 * a line indented less than the content column ends the item's paragraph and
 * closes the item. Blank lines and fenced content are not structure, so they
 * cannot close an item.
 */
function enclosingContentColumn(lines, fenceIndex, fenced) {
	const fenceWidth = indentWidth(lines[fenceIndex]);

	for (let i = fenceIndex - 1; i >= 0; i--) {
		if (fenced[i] || lines[i].trim() === '') continue;

		const column = contentColumnOf(lines[i]);
		if (column === null || fenceWidth < column) continue;

		const owns = everyLineBetweenAtLeast(lines, i, fenceIndex, fenced, column);
		if (owns) return column;
	}

	return 0;
}

function everyLineBetweenAtLeast(lines, from, to, fenced, column) {
	for (let j = from + 1; j < to; j++) {
		if (fenced[j] || lines[j].trim() === '') continue;
		if (indentWidth(lines[j]) < column) return false;
	}
	return true;
}

/**
 * Report every structural defect in a markdown document, by 1-based line.
 *
 * Two rules, each of which is a CommonMark requirement the original
 * reindentation broke:
 *   - a fence opener must be indented between its container's content column
 *     and that column plus 3. Outside that range it is not a fence at all: too
 *     far right and it becomes an indented code block, too far left and it has
 *     escaped its list item;
 *   - no line inside an open fence may be indented less than the opener, or the
 *     block ends early and the remainder is read as a new paragraph.
 */
function structuralProblems(markdown) {
	const lines = markdown.split('\n');
	const { fenced, openerOf } = markFencedLines(lines);
	const problems = [];

	for (let i = 0; i < lines.length; i++) {
		if (openerOf[i] !== i) continue;

		const column = enclosingContentColumn(lines, i, fenced);
		const width = indentWidth(lines[i]);
		if (width < column || width > column + 3) {
			problems.push(
				`line ${i + 1}: fence indent ${width} is outside the valid ` +
					`[${column}, ${column + 3}] range of its enclosing block (content column ${column})`,
			);
		}

		const open = FENCE_OPEN.exec(lines[i]);
		let end = i + 1;
		while (end < lines.length && !isClosingFence(lines[end], open[2])) {
			if (indentWidth(lines[end]) < width) {
				problems.push(
					`line ${end + 1}: indent ${indentWidth(lines[end])} is less than the ` +
						`opening fence's ${width}, so the block ends early`,
				);
				break;
			}
			end++;
		}
		if (end >= lines.length) problems.push(`line ${i + 1}: fence is never closed`);
	}

	return problems;
}

/**
 * The structural shape each payload region had on `origin/master`, pinned
 * field by field. Every field is markdown-significant:
 *
 *   - `introducerIndent` / `introducerMarker` decide which block owns the step.
 *     A marker that loses its indent is no longer the sub-item it was — it is
 *     promoted to a top-level peer of its own parent, and everything after it
 *     re-nests underneath the promoted item.
 *   - `fenceIndent` decides whether the block renders as a shell block at all.
 *     Four spaces after a top-level paragraph is not a fence; it is absorbed as
 *     lazy continuation, so the curl collapses into one inline `<code>` blob
 *     prefixed with a literal `bash`.
 *
 * Regions are located by a substring of the introducing line rather than by
 * line number, so an unrelated edit earlier in the file does not move them.
 */
const PAYLOAD_REGION_SHAPE = [
	{
		region: 'notification helper',
		introducer: '**Notification helper**',
		introducerIndent: 0,
		introducerMarker: null,
		fenceIndent: 0,
	},
	{
		region: 'both-channels example',
		introducer: 'For backward compatibility you may send',
		introducerIndent: 0,
		introducerMarker: null,
		fenceIndent: 0,
	},
	{
		region: 'need manual PR deploy (Step 6.5, item 3 continuation)',
		introducer: 'Send a WhatsApp notification with issue and PR links to',
		introducerIndent: 3,
		introducerMarker: null,
		fenceIndent: 3,
	},
	{
		region: 'In review handoff (Step 7, item 6)',
		introducer: 'Send an `In review` notification to WhatsApp',
		introducerIndent: 0,
		introducerMarker: '6.',
		fenceIndent: 3,
	},
	{
		region: 'CLI auth global deadlock (Error Handling, sub-step)',
		introducer: 'Send a WhatsApp global-deadlock notification to',
		introducerIndent: 2,
		introducerMarker: '-',
		fenceIndent: 4,
	},
];

/**
 * Defects in one pinned region, reported as `field: actual != expected`.
 *
 * The sibling rule covers the marker case: a line that *is* a list item must
 * sit at the same indent as the list item it continues, otherwise it has been
 * promoted out of its parent list. That is valid markdown — which is why the
 * payload regexes could never have caught it — but it is no longer the step the
 * surrounding prose describes.
 */
function regionShapeProblems(markdown, shape) {
	const lines = markdown.split('\n');
	const problems = [];

	const matches = [];
	lines.forEach((line, index) => {
		if (line.includes(shape.introducer)) matches.push(index);
	});

	if (matches.length !== 1) {
		return [`introducer: found ${matches.length} lines, expected exactly 1`];
	}

	const index = matches[0];
	const line = lines[index];

	const width = indentWidth(line);
	if (width !== shape.introducerIndent) {
		problems.push(`introducerIndent: ${width} != ${shape.introducerIndent}`);
	}

	const marker = listMarkerOf(line);
	if (marker !== shape.introducerMarker) {
		problems.push(`introducerMarker: ${marker} != ${shape.introducerMarker}`);
	}

	if (shape.introducerMarker !== null) {
		const previous = nearestPrecedingListItem(lines, index);
		if (previous !== null && previous !== width) {
			problems.push(
				`introducer is a list item at indent ${width} but the step it belongs ` +
					`with is at indent ${previous}: it was promoted out of its parent list`,
			);
		}
	}

	let fenceLine = index + 1;
	while (fenceLine < lines.length && lines[fenceLine].trim() === '') fenceLine++;

	const next = lines[fenceLine];
	if (next === undefined || FENCE_OPEN.exec(next) === null) {
		problems.push('fence: no fence opener follows the introducer');
		return problems;
	}

	const fenceWidth = indentWidth(next);
	if (fenceWidth !== shape.fenceIndent) {
		problems.push(`fenceIndent: ${fenceWidth} != ${shape.fenceIndent}`);
	}

	return problems;
}

/** Indent of the nearest list item above `index`, or `null` if there is none. */
function nearestPrecedingListItem(lines, index) {
	for (let i = index - 1; i >= 0; i--) {
		if (lines[i].trim() === '') continue;
		if (contentColumnOf(lines[i]) !== null) return indentWidth(lines[i]);
	}
	return null;
}

/**
 * Resolve the shell quoting in a payload the way `sh` would for the two tokens
 * the templates use, then parse the result as JSON.
 */
function renderPayload(body, { chatId, message = 'notification body' }) {
	const rendered = body
		.replaceAll(KNOB_QUOTED, chatId)
		.replaceAll('\'"${NOTIFY_WHATSAPP_CHAT_ID:-' + REQUESTED_GROUP + '}"\'', chatId)
		.replace(/\$\{NOTIFY_WHATSAPP_CHAT_ID:-[^}]*\}/g, chatId)
		.replaceAll('\'"${NOTIFY_MESSAGE}"\'', message)
		.replaceAll('"${NOTIFY_MESSAGE}"', message);
	return JSON.parse(rendered);
}

describe('issue-automator PR notification destination (issue #928)', () => {
	it('documents NOTIFY_WHATSAPP_CHAT_ID with the requested group as its default', () => {
		const skill = read();

		const declaration = skill
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line.includes('NOTIFY_WHATSAPP_CHAT_ID'));

		expect(declaration).toBeDefined();
		expect(declaration).toContain('NOTIFY_WHATSAPP_CHAT_ID');
		expect(declaration).toMatch(/defaults? to/i);
		expect(declaration).toContain(REQUESTED_GROUP);
	});

	it('routes every notification payload through NOTIFY_WHATSAPP_CHAT_ID', () => {
		const payloads = notificationPayloads(read());
		expect(payloads.length).toBeGreaterThan(0);

		const bypassed = payloads
			.filter((payload) => !payload.body.includes('NOTIFY_WHATSAPP_CHAT_ID'))
			.map((payload) => `SKILL.md:${payload.line}`);

		expect(bypassed).toEqual([]);
	});

	it('never bakes a WhatsApp group literal into a notification payload', () => {
		const payloads = notificationPayloads(read());

		const hardcoded = payloads
			.filter((payload) => LITERAL_DESTINATION.test(payload.body))
			.map((payload) => `SKILL.md:${payload.line}`);

		expect(hardcoded).toEqual([]);
	});

	it('every notification payload resolves to valid JSON at the default destination', () => {
		for (const payload of notificationPayloads(read())) {
			const parsed = renderPayload(payload.body, { chatId: REQUESTED_GROUP });

			expect(parsed.channels).toContain('whatsapp');
			expect(parsed.whatsappChatId).toBe(REQUESTED_GROUP);
			expect(typeof parsed.message).toBe('string');
			expect(parsed.message.length).toBeGreaterThan(0);
		}
	});

	it('an overridden NOTIFY_WHATSAPP_CHAT_ID changes the destination without editing the skill', () => {
		const override = '120363000000000999@g.us';

		for (const payload of notificationPayloads(read())) {
			const parsed = renderPayload(payload.body, { chatId: override });

			expect(parsed.whatsappChatId).toBe(override);
			expect(parsed.whatsappChatId).not.toBe(REQUESTED_GROUP);
		}
	});

	it('renders WhatsApp as a notification channel even when only the destination is set', () => {
		// The channel mandate is unconditional (the operator requires WhatsApp);
		// only the *destination* is operator-configurable. Resolving the
		// destination through a variable must not silently drop the channel.
		for (const payload of notificationPayloads(read())) {
			const parsed = renderPayload(payload.body, { chatId: '120363000000000999@g.us' });
			expect(parsed.channels).toEqual(['whatsapp']);
		}
	});

	it('names no WhatsApp group other than the requested destination', () => {
		const skill = read();
		const groups = new Set(skill.match(ANY_GROUP) || []);

		expect([...groups]).toEqual([REQUESTED_GROUP]);
	});

	it('keeps a runnable curl template that resolves the destination from the knob', () => {
		const skill = read();

		// At least one payload must use the shell-quoted knob form so the value
		// survives inside the JSON string of a single-quoted --data-raw argument.
		const usesQuotedKnob = notificationPayloads(skill).some((payload) =>
			payload.body.includes(KNOB_QUOTED),
		);

		expect(usesQuotedKnob).toBe(true);
	});
});

/**
 * The two regions as this PR's first revision actually committed them. They are
 * the literal bytes that shipped and passed CI, so a guard that cannot flag
 * these two documents has no teeth and must not be trusted on the real file.
 */
const BROKEN_CONTINUATION_REGION = [
	'3. **If recovery fails** (no `railway` CLI auth, push rejected):',
	'   ```bash',
	'   gh pr edit <PR_NUMBER> --add-label "need manual PR deploy" 2>/dev/null || true',
	'   ```',
	'Send a WhatsApp notification with issue and PR links to `NOTIFY_WHATSAPP_CHAT_ID`:',
	'    ```bash',
	'    PR_URL="https://github.com/francovp/cabros-bot/pull/${PR_NUMBER}"',
	'    ```',
	'   Append the issue number to `SKIPPED_ISSUES`.',
].join('\n');

const CORRECT_CONTINUATION_REGION = BROKEN_CONTINUATION_REGION.replace(
	'\nSend a WhatsApp notification with issue and PR links to',
	'\n   Send a WhatsApp notification with issue and PR links to',
).replace(
	'\n    ```bash\n    PR_URL=',
	'\n   ```bash\n   PR_URL=',
).replace(
	'\n    ```\n   Append',
	'\n   ```\n   Append',
);

const BROKEN_MARKER_REGION = [
	'- **CLI Authentication Failures**: If `gh` CLI calls fail due to auth:',
	'  - If the CLI is unavailable, use GitHub MCP if available. If both access paths fail:',
	'- Send a WhatsApp global-deadlock notification to `NOTIFY_WHATSAPP_CHAT_ID`:',
	'     ```bash',
	'     ISSUE_URL="https://github.com/$repo/issues/$issue"',
	'     ```',
	'  - Then end the run with outcome `GLOBAL_BLOCKED`.',
].join('\n');

const CORRECT_MARKER_REGION = [
	'- **CLI Authentication Failures**: If `gh` CLI calls fail due to auth:',
	'  - If the CLI is unavailable, use GitHub MCP if available. If both access paths fail:',
	'  - Send a WhatsApp global-deadlock notification to `NOTIFY_WHATSAPP_CHAT_ID`:',
	'    ```bash',
	'    ISSUE_URL="https://github.com/$repo/issues/$issue"',
	'    ```',
	'  - Then end the run with outcome `GLOBAL_BLOCKED`.',
].join('\n');

describe('issue-automator payload regions keep their markdown structure', () => {
	it('has no structural defect anywhere in the skill', () => {
		expect(structuralProblems(read())).toEqual([]);
	});

	it.each(PAYLOAD_REGION_SHAPE.map((shape) => [shape.region, shape]))(
		'%s keeps its pinned structure',
		(_region, shape) => {
			expect(regionShapeProblems(read(), shape)).toEqual([]);
		},
	);

	it('pins every payload region, so a new one cannot appear unpinned', () => {
		const lines = read().split('\n');
		const { fenced, openerOf } = markFencedLines(lines);

		const payloadFenceIndents = [];
		for (let i = 0; i < lines.length; i++) {
			if (openerOf[i] !== i) continue;

			for (let j = i; j < lines.length && fenced[j]; j++) {
				if (!lines[j].includes('--data-raw')) continue;
				payloadFenceIndents.push(indentWidth(lines[i]));
				break;
			}
		}

		expect(payloadFenceIndents.sort((a, b) => a - b)).toEqual(
			PAYLOAD_REGION_SHAPE.map((shape) => shape.fenceIndent).sort((a, b) => a - b),
		);
	});
});

describe('the structural guard detects the indentation regression it exists for', () => {
	it('flags a payload whose continuation line lost its list indent', () => {
		const shape = PAYLOAD_REGION_SHAPE.find((entry) =>
			entry.introducer.startsWith('Send a WhatsApp notification with issue'),
		);

		expect(structuralProblems(BROKEN_CONTINUATION_REGION).join('\n')).toMatch(
			/fence indent 4 is outside the valid \[0, 3\]/,
		);
		expect(regionShapeProblems(BROKEN_CONTINUATION_REGION, shape).join('\n')).toMatch(
			/introducerIndent: 0 != 3/,
		);

		expect(structuralProblems(CORRECT_CONTINUATION_REGION)).toEqual([]);
		expect(regionShapeProblems(CORRECT_CONTINUATION_REGION, shape)).toEqual([]);
	});

	it('flags a payload sub-step that was promoted out of its parent list', () => {
		const shape = PAYLOAD_REGION_SHAPE.find((entry) =>
			entry.introducer.startsWith('Send a WhatsApp global-deadlock'),
		);

		const broken = regionShapeProblems(BROKEN_MARKER_REGION, shape);
		expect(broken).not.toEqual([]);
		expect(broken.join('\n')).toMatch(/introducerIndent: 0 != 2/);
		expect(broken.join('\n')).toMatch(/promoted out of its parent list/);
		expect(broken.join('\n')).toMatch(/fenceIndent: 5 != 4/);

		expect(regionShapeProblems(CORRECT_MARKER_REGION, shape)).toEqual([]);
	});
});