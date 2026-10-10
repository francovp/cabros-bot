'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { schemaFor, fieldSchema, present, typeOf, plainText } = require('../../src/admin/admin-components');
const contract = require('../../src/openapi/openapi.json');

const renderNullableNumberField = (value) => {
	const registered = {};
	const h = (type, props, children) => {
		if (children === undefined && (Array.isArray(props) || typeof props === 'string')) {
			children = props;
			props = {};
		}
		return { type, props: props || {}, children: Array.isArray(children) ? children : children === undefined ? [] : [children] };
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/admin/admin-components.js'), 'utf8'), {
		window: { Vue: { h, ref: (initial) => ({ value: initial }), defineCustomElement: (definition) => definition } },
		customElements: { define: (name, definition) => { registered[name] = definition; } },
	});

	const updates = [];
	const schema = { type: 'object', properties: { quietHoursStart: { type: ['integer', 'null'], minimum: 0, maximum: 23 } } };
	const wrapper = registered['cabros-fields'].setup({ value: { quietHoursStart: value }, schema, heading: 'Options' }, {
		emit: (_event, next) => updates.push(next),
	})();
	const root = wrapper.type.setup(wrapper.props, { emit: (_event, next) => wrapper.props.onUpdate(next) })();
	const find = (node, predicate) => {
		if (!node || typeof node !== 'object') return undefined;
		if (predicate(node)) return node;
		for (const child of node.children || []) {
			const found = find(child, predicate);
			if (found) return found;
		}
		return undefined;
	};
	const field = find(root, (node) => node.type === wrapper.type && node.props.title === 'Quiet Hours Start');
	const rendered = field.type.setup(field.props, { emit: (_event, next) => field.props.onUpdate(next) })();
	const nullOption = find(rendered, (node) => node.type === 'input' && node.props.type === 'checkbox');
	return { nullOption, updates };
};

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

	it('emits null when the operator selects the nullable number option', () => {
		const { nullOption, updates } = renderNullableNumberField(22);

		expect(nullOption).toBeDefined();
		nullOption.props.onChange({ target: { checked: true } });
		expect(updates).toEqual([{ quietHoursStart: null }]);
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
