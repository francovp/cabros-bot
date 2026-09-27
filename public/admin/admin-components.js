'use strict';

/* global window, customElements */
// Vue runtime render functions keep the console compatible with its strict CSP.
(function() {
	const label = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
	const schemaFor = (contract, schema, depth = 0) => {
		if (!schema || typeof schema !== 'object' || depth > 20) return {};
		if (schema.$ref) return schemaFor(contract, schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key], contract), depth + 1);
		const result = { ...schema };
		if (schema.oneOf) result.variants = schema.oneOf.map((part) => schemaFor(contract, part, depth + 1));
		for (const part of schema.allOf || schema.oneOf || schema.anyOf || []) {
			const resolved = schemaFor(contract, part, depth + 1);
			result.properties = { ...result.properties, ...resolved.properties };
			if (schema.allOf) result.required = [...new Set([...(result.required || []), ...(resolved.required || [])])];
			if (!result.type && resolved.type) result.type = resolved.type;
		}
		if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, prop]) => [key, schemaFor(contract, prop, depth + 1)]));
		if (result.items) result.items = schemaFor(contract, result.items, depth + 1);
		for (const variant of result.variants || []) {
			for (const [key, prop] of Object.entries(variant.properties || {})) {
				if (prop.const !== undefined) {
					const values = result.variants.map((item) => item.properties?.[key]?.const).filter((item) => item !== undefined);
					result.properties[key] = { type: 'string', enum: [...new Set(values)] };
				}
			}
		}
		return result;
	};
	const fieldSchema = (schema, value) => {
		const variant = schema.variants?.find((item) => Object.entries(item.properties || {}).some(([key, prop]) => prop.const !== undefined && value?.[key] === prop.const));
		if (!variant) return schema;
		return { ...schema, ...variant, properties: Object.fromEntries(Object.entries(variant.properties || {}).map(([key, prop]) => [key, prop.const !== undefined ? schema.properties[key] : prop])) };
	};
	const plainText = (value, depth = 0) => {
		if (value === null || value === undefined) return '—';
		if (typeof value === 'boolean') return value ? 'Yes' : 'No';
		if (typeof value !== 'object') return String(value);
		return Object.entries(value).map(([key, item]) => `${'  '.repeat(depth)}${label(key)}: ${plainText(item, depth + 1)}`).join('\n');
	};
	const present = (value, dryRun = false, secret = '') => {
		if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
		if (!value || typeof value !== 'object') return value;
		const simulated = dryRun || value.dryRun === true;
		if (Array.isArray(value)) return value.map((item) => present(item, simulated, secret));
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [
			simulated && /^(alerts_sent|alertsSent)$/.test(key) ? 'alertsGenerated' : key,
			/secret|password|authorization|cookie|^(?:api.?key|access.?token|refresh.?token|id.?token|token)$/i.test(key) ? '[REDACTED]' : present(item, simulated, secret),
		]));
	};
	// Decimal strings must remain strings, especially for Binance order quantities.
	const typeOf = (schema, value) => (Array.isArray(schema.type) ? schema.type.includes('string') ? 'string' : schema.type.find((type) => type !== 'null') : schema.type)
		|| (schema.properties ? 'object' : Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string');
	const api = { schemaFor, fieldSchema, plainText, label, present, typeOf };
	if (typeof module !== 'undefined') module.exports = api;
	if (typeof window === 'undefined') return;
	window.CabrosAdminComponents = api;
	const { h, defineCustomElement, ref } = window.Vue;
	let nextId = 0;
	const initial = (schema) => schema.default ?? schema.const ?? (schema.enum ? schema.enum[0] : ({ object: {}, array: [], boolean: false, number: 0, integer: 0 }[typeOf(schema)] ?? ''));

	const Field = {
		props: ['schema', 'value', 'title', 'required'],
		emits: ['update'],
		setup(props, { emit }) {
			const id = `visual-field-${++nextId}`;
			const newKey = ref('');
			const newType = ref('string');
			const update = (value) => emit('update', value);
			return () => {
				const value = props.value;
				const schema = fieldSchema(props.schema || {}, value);
				const type = typeOf(schema, value);
				const title = `${props.title}${props.required ? ' *' : ''}`;
				const hint = schema.description ? h('small', { id: `${id}-hint`, class: 'field-hint' }, schema.description) : null;
				const active = value !== undefined;
				const toggle = !props.required && ['object', 'array', 'boolean'].includes(type)
					? h('label', { class: 'checkbox-label field-toggle' }, [h('input', { type: 'checkbox', checked: active, onChange: (event) => update(event.target.checked ? initial(schema) : undefined) }), `Set ${props.title.toLowerCase()}`]) : null;
				if (type === 'object') {
					const object = value || {};
					const properties = { ...schema.properties };
					Object.keys(object).forEach((key) => { if (!properties[key]) properties[key] = {}; });
					const set = (key, item) => {
						const updated = { ...object, [key]: item };
						if (item === undefined) delete updated[key];
						if (props.schema?.variants?.some((variant) => variant.properties?.[key]?.const !== undefined)) {
							const selected = fieldSchema(props.schema, updated);
							Object.keys(updated).forEach((name) => { if (props.schema.properties?.[name] && !selected.properties?.[name]) delete updated[name]; });
						}
						update(updated);
					};
					return h('fieldset', { class: 'visual-group' }, [h('legend', title), hint, toggle,
						active || props.required ? h('div', { class: 'visual-fields' }, Object.entries(properties).map(([key, child]) => h(Field, {
							key, title: label(key), schema: child, value: object[key], required: (schema.required || []).includes(key), onUpdate: (item) => set(key, item),
						}))) : null,
						(active || props.required) && schema.additionalProperties !== false ? h('div', { class: 'property-adder' }, [
							h('input', { 'aria-label': `${props.title} extra field name`, placeholder: 'Additional field', value: newKey.value, onInput: (e) => { newKey.value = e.target.value; } }),
							h('select', { 'aria-label': 'Field type', value: newType.value, onChange: (e) => { newType.value = e.target.value; } }, ['string', 'number', 'boolean', 'array', 'object'].map((kind) => h('option', { value: kind }, label(kind)))),
							h('button', { type: 'button', disabled: !newKey.value.trim() || Object.hasOwn(object, newKey.value.trim()) || ['__proto__', 'constructor', 'prototype'].includes(newKey.value.trim()), onClick: () => { set(newKey.value.trim(), initial({ type: newType.value })); newKey.value = ''; } }, 'Add field'),
						]) : null,
					]);
				}
				if (type === 'array') {
					const items = Array.isArray(value) ? value : [];
					const itemSchema = schema.items || {};
					return h('fieldset', { class: 'visual-group' }, [h('legend', title), hint, toggle,
						active || props.required ? h('div', { class: 'visual-array' }, [
							...items.map((item, index) => h('div', { class: 'array-row', key: index }, [
								h(Field, { schema: itemSchema, value: item, title: `${props.title} ${index + 1}`, required: true, onUpdate: (next) => update(items.map((old, i) => i === index ? next : old)) }),
								h('button', { type: 'button', class: 'button-ghost', 'aria-label': `Remove ${props.title} ${index + 1}`, disabled: items.length <= (schema.minItems || 0), onClick: () => update(items.filter((_, i) => i !== index)) }, 'Remove'),
							])),
							h('button', { type: 'button', disabled: items.length >= (schema.maxItems ?? Infinity), onClick: () => update([...items, initial(itemSchema)]) }, '+ Add item'),
						]) : null,
					]);
				}
				const attrs = { id, 'aria-describedby': hint ? `${id}-hint` : undefined, required: Boolean(props.required), value: value ?? '',
					min: schema.minimum, max: schema.maximum, minlength: schema.minLength, maxlength: schema.maxLength,
					ref: (input) => {
						if (input && schema.pattern) input.setCustomValidity(value && !new RegExp(schema.pattern).test(String(value)) ? `Check the format for ${props.title.toLowerCase()}.` : '');
					},
				};
				let control;
				if (type === 'boolean') {
					control = h('select', { ...attrs, value: active ? String(value) : '', onChange: (e) => update(e.target.value === '' ? undefined : e.target.value === 'true') }, [
						!props.required ? h('option', { value: '' }, 'Use default') : null, h('option', { value: 'true' }, 'Yes'), h('option', { value: 'false' }, 'No'),
					]);
				} else if (schema.enum) {
					control = h('select', { ...attrs, onChange: (e) => update(e.target.value === '' ? undefined : schema.enum.find((item) => String(item) === e.target.value)) }, [
						h('option', { value: '' }, props.required ? 'Select an option' : 'Use default'), ...schema.enum.map((item) => h('option', { value: item }, String(item))),
					]);
				} else {
					const numeric = ['number', 'integer'].includes(type);
					const multiline = /text|message|prompt|description/i.test(props.title) && !numeric;
					const inputControl = h(multiline ? 'textarea' : 'input', { ...attrs, rows: multiline ? 3 : undefined,
						type: numeric ? 'number' : /secret|password|token|api.?key/i.test(props.title) ? 'password' : schema.format === 'uri' ? 'url' : 'text',
						step: numeric ? type === 'integer' ? 1 : 'any' : undefined,
						onInput: (e) => update(e.target.value === '' ? undefined : numeric ? e.target.valueAsNumber : e.target.value),
					});
					control = numeric && Array.isArray(schema.type) && schema.type.includes('null')
						? h('div', { class: 'nullable-number' }, [inputControl, h('label', { class: 'checkbox-label' }, [
							h('input', { type: 'checkbox', checked: value === null, onChange: (e) => update(e.target.checked ? null : undefined) }),
							'No value (null)',
						])])
						: inputControl;
				}
				return h('div', { class: 'visual-field' }, [h('label', { for: id }, title), control, hint]);
			};
		},
	};
	const Result = {
		props: ['value', 'title'],
		setup(props) {
			return () => {
				const value = props.value;
				if (Array.isArray(value)) {
					if (!value.length) return h('p', { class: 'empty-state' }, 'No results.');
					if (value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
						const keys = [...new Set(value.flatMap(Object.keys))];
						return h('div', { class: 'table-scroll', tabindex: 0, role: 'region', 'aria-label': props.title || 'Results' }, [h('table', { class: 'results-table' }, [
							h('caption', props.title || 'Results'), h('thead', [h('tr', keys.map((key) => h('th', { scope: 'col' }, label(key))))]),
							h('tbody', value.map((item) => h('tr', keys.map((key) => h('td', [h(Result, { value: item[key], title: label(key) })]))))),
						])]);
					}
					return h('ul', { class: 'result-items' }, value.map((item) => h('li', [h(Result, { value: item })])));
				}
				if (value && typeof value === 'object') return h('dl', { class: 'visual-result' }, Object.entries(value).map(([key, item]) => h('div', { class: 'result-entry' }, [h('dt', label(key)), h('dd', [h(Result, { value: item, title: label(key) })])])));
				return h('span', { class: typeof value === 'boolean' ? `status-badge ${value ? 'ready' : 'disabled'}` : 'result-value' }, plainText(value));
			};
		},
	};
	customElements.define('cabros-fields', defineCustomElement({
		shadowRoot: false, props: ['value', 'schema', 'heading'], emits: ['update'],
		setup: (props, { emit }) => () => h(Field, { value: props.value, schema: props.schema, title: props.heading || 'Options', required: true, onUpdate: (value) => emit('update', value) }),
	}));
	customElements.define('cabros-result', defineCustomElement({ shadowRoot: false, props: ['value'], setup: (props) => () => h(Result, { value: props.value }) }));
}());
