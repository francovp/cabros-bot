'use strict';

const { schemaFor, fieldSchema, present, typeOf, plainText } = require('../../src/admin/admin-components');
const contract = require('../../src/openapi/openapi.json');

describe('visual admin components', () => {
	it('redacts credentials in result text without hiding token usage metrics', () => {
		const result = present({ tokenUsage: { totalTokens: 42 }, message: 'Rejected key: a"b', accessToken: 'secret' }, false, 'a"b');
		expect(result.tokenUsage.totalTokens).toBe(42);
		expect(result.message).toBe('Rejected key: [REDACTED]');
		expect(result.accessToken).toBe('[REDACTED]');
	});

	it('resolves the job discriminator and exposes only the selected contract fields', () => {
		const schema = schemaFor(contract, { $ref: '#/components/schemas/TradingViewJobRequest' });
		expect(schema.properties.type.enum).toEqual(['expanded-analysis', 'market-scanner']);
		const selected = fieldSchema(schema, { type: 'market-scanner' });
		expect(selected.properties.scans.items.enum).toContain('top_gainers');
		expect(selected.properties.callbackSecret).toBeDefined();
		expect(selected.properties.symbols).toBeUndefined();
		expect(selected.required).toContain('type');
	});

	it('keeps exact financial quantities editable as text, not floating point numbers', () => {
		const schema = schemaFor(contract, { $ref: '#/components/schemas/BinanceOrderRequest' });
		expect(typeOf(schema.properties.quantity, '0.1234567890123456789')).toBe('string');
		expect(typeOf({ type: 'integer' }, 3)).toBe('integer');
	});

	it('renders simulated delivery and nested secrets truthfully without changing API data', () => {
		const data = { dryRun: true, summary: { alerts_sent: 2 }, results: [{ callbackSecret: 'private', value: 0 }] };
		const displayed = present(data);
		expect(displayed.summary).toEqual({ alertsGenerated: 2 });
		expect(displayed.results[0]).toEqual({ callbackSecret: '[REDACTED]', value: 0 });
		expect(plainText(displayed)).not.toContain('private');
		expect(data.summary.alerts_sent).toBe(2);
	});
});
