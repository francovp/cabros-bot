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
 *      notification destination.
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