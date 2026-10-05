'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SVG_NS = 'http://www.w3.org/2000/svg';
const SOURCE_PATH = path.join(__dirname, '../../src/admin/admin-charts.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../../src/admin/admin.css'), 'utf8');
const SHELL = fs.readFileSync(path.join(__dirname, '../../src/admin/index.html'), 'utf8');
const FORBIDDEN_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML'];

class FakeNode {
	constructor(tagName, namespaceURI = null) {
		this.tagName = String(tagName).toUpperCase();
		this.namespaceURI = namespaceURI;
		this.children = [];
		this.attributes = {};
		this._text = '';
		// The DOM exposes `className` for both HTML and SVG elements, so back it with the
		// `class` attribute to catch paint classes that were applied with setAttribute.
		Object.defineProperty(this, 'className', {
			configurable: true,
			get() {
				return Object.hasOwn(this.attributes, 'class') ? this.attributes.class : '';
			},
			set(value) {
				this.attributes.class = String(value);
			},
		});
		FORBIDDEN_SINKS.forEach((name) => {
			Object.defineProperty(this, name, {
				configurable: true,
				get() {
					throw new Error(`${this.tagName}.${name} was read; chart primitives must build DOM nodes only.`);
				},
				set() {
					throw new Error(`${this.tagName}.${name} was assigned; chart primitives must build DOM nodes only.`);
				},
			});
		});
	}

	get textContent() {
		return this._text + this.children.map((child) => child.textContent).join('');
	}

	set textContent(value) {
		this._text = String(value);
		this.children = [];
	}

	append(...nodes) {
		nodes.forEach((node) => {
			node.parentNode = this;
			this.children.push(node);
		});
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}

	getAttribute(name) {
		return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
	}
}

const createDocument = () => {
	const document = {
		createElement: (tag) => new FakeNode(tag),
		createElementNS: (namespaceURI, tag) => {
			if (namespaceURI !== SVG_NS) throw new Error(`Unexpected SVG namespace: ${namespaceURI}`);
			return new FakeNode(tag, namespaceURI);
		},
	};
	Object.defineProperty(document, 'write', {
		configurable: true,
		get() {
			throw new Error('document.write was read; the chart kit must never inject markup.');
		},
	});
	return document;
};

const loadCharts = () => {
	const document = createDocument();
	const context = { document, window: {} };
	vm.runInNewContext(SOURCE, context, { filename: 'admin-charts.js' });
	return { document, charts: context.window.CabrosAdminCharts };
};

const walk = (node, visit) => {
	visit(node);
	node.children.forEach((child) => walk(child, visit));
};

const byTag = (root, tagName) => {
	const matches = [];
	walk(root, (node) => {
		if (node.tagName === tagName.toUpperCase()) matches.push(node);
	});
	return matches;
};

const svgOf = (root) => {
	const found = [];
	walk(root, (node) => {
		if (node.namespaceURI === SVG_NS && node.tagName === 'SVG') found.push(node);
	});
	return found[0];
};

const classesOf = (node) => String(node.className || '').split(/\s+/).filter(Boolean);

const viewBoxOf = (root) => {
	const box = String(svgOf(root).getAttribute('viewBox') || '').split(/\s+/).map(Number);
	return { width: box[2], height: box[3] };
};

// A `display: table` box resolves its used width to max(specified, min-content), so the class
// must never land on one: an absolutely positioned table sized by its content widens the page.
const tablesWithVisuallyHidden = (root) => byTag(root, 'table')
	.filter((table) => classesOf(table).includes('visually-hidden'));

const textBoxes = (root) => byTag(root, 'text').map((text) => ({
	text: text.textContent,
	x: Number(text.getAttribute('x')),
	anchor: text.getAttribute('text-anchor'),
	fontSize: classesOf(text).includes('chart-category-text') ? 12 : 11,
}));

// Every emitted attribute must be a real coordinate, never NaN/Infinity/undefined.
const expectNoBrokenNumbers = (root) => {
	walk(root, (node) => {
		Object.entries(node.attributes).forEach(([name, value]) => {
			expect(value).not.toMatch(/NaN|Infinity|undefined|null/);
			expect(name).not.toBe('undefined');
		});
	});
};

const tableRows = (root) => byTag(root, 'tr').slice(1).map((row) => byTag(row, 'td').map((cell) => cell.textContent));

describe('admin chart primitives', () => {
	let charts;

	beforeEach(() => {
		({ charts } = loadCharts());
	});

	describe('module surface', () => {
		it('exposes the four documented render functions on the browser global', () => {
			['sparkline', 'lineChart', 'barChart', 'donutChart'].forEach((name) => {
				expect(typeof charts[name]).toBe('function');
			});
			expect(charts.SERIES_SLOTS).toBe(6);
			expect(charts.DEFAULT_EMPTY_TEXT).toBeTruthy();
		});

		it('is also requireable as a CommonJS module for node-side assertions', () => {
			const required = require('../../src/admin/admin-charts');
			['sparkline', 'lineChart', 'barChart', 'donutChart'].forEach((name) => {
				expect(typeof required[name]).toBe('function');
			});
		});
	});

	describe('sparkline', () => {
		it('renders an inline SVG whose aria-label states the finding in words', () => {
			const node = charts.sparkline([10, 31, 12], { label: 'Alerts per hour' });
			const svg = svgOf(node);

			expect(svg.getAttribute('role')).toBe('img');
			expect(svg.getAttribute('aria-label')).toBe('Alerts per hour. 3 points, high 31, low 10, latest 12.');
			expect(byTag(node, 'polyline')).toHaveLength(1);
			expect(byTag(node, 'circle')).toHaveLength(3);
			expectNoBrokenNumbers(node);
		});

		it('ships an equivalent visually hidden data table with the same numbers', () => {
			const node = charts.sparkline([10, 31, 12], { label: 'Alerts per hour' });
			const table = byTag(node, 'table')[0];
			const holder = table.parentNode;

			expect(classesOf(table)).toEqual(expect.arrayContaining(['chart-data-table']));
			expect(classesOf(holder)).toEqual(expect.arrayContaining(['visually-hidden']));
			expect(holder.tagName).not.toBe('TABLE');
			expect(byTag(table, 'caption')[0].textContent).toBe('Alerts per hour values');
			expect(tableRows(table)).toEqual([['1', '10'], ['2', '31'], ['3', '12']]);
		});

		it('keeps the hidden table inside the holder so it is still exposed to assistive tech', () => {
			const node = charts.sparkline([10, 31, 12], { label: 'Alerts per hour' });
			const holder = node.children[1];
			const table = byTag(holder, 'table');

			expect(classesOf(holder)).toEqual(expect.arrayContaining(['visually-hidden']));
			expect(table).toHaveLength(1);
			expect(byTag(table[0], 'tr')).toHaveLength(4);
			expect(byTag(table[0], 'caption')).toHaveLength(1);
		});

		it('honours a custom value formatter in both the label and the table', () => {
			const node = charts.sparkline([0.5, 0.75], { label: 'Win rate', formatValue: (value) => `${Math.round(value * 100)}%` });

			expect(svgOf(node).getAttribute('aria-label')).toContain('high 75%, low 50%');
			expect(tableRows(node)[0]).toEqual(['1', '50%']);
		});

		it('renders a single point as one dot instead of an invisible polyline', () => {
			const node = charts.sparkline([42], { label: 'Only sample' });
			const svg = svgOf(node);

			expect(byTag(node, 'polyline')).toHaveLength(0);
			expect(byTag(node, 'circle')).toHaveLength(1);
			expect(svg.getAttribute('aria-label')).toBe('Only sample. 1 point, high 42, low 42, latest 42.');
			expectNoBrokenNumbers(node);
		});

		it('centres a flat series instead of dividing by a zero range', () => {
			const node = charts.sparkline([7, 7, 7], { label: 'Flat' });
			const circles = byTag(node, 'circle');
			const yPositions = circles.map((circle) => circle.getAttribute('cy'));

			expect(new Set(yPositions).size).toBe(1);
			expectNoBrokenNumbers(node);
		});

		it('breaks the line into separate runs around non-finite samples', () => {
			const node = charts.sparkline([1, Number.NaN, 3, 4], { label: 'Gappy' });

			expect(byTag(node, 'polyline')).toHaveLength(1);
			expect(byTag(node, 'circle')).toHaveLength(3);
			expect(svgOf(node).getAttribute('aria-label')).toContain('high 4');
			expect(tableRows(node)).toEqual([['1', '1'], ['2', '—'], ['3', '3'], ['4', '4']]);
			expectNoBrokenNumbers(node);
		});

		it('handles a series long enough to overflow a spread call stack', () => {
			const long = Array.from({ length: 200000 }, (unused, index) => index % 977);
			const node = charts.sparkline(long, { label: 'Long' });

			expect(byTag(node, 'circle')).toHaveLength(long.length);
			expectNoBrokenNumbers(node);
		});

		it('accepts negative values', () => {
			const node = charts.sparkline([-5, 5], { label: 'PnL' });

			expect(svgOf(node).getAttribute('aria-label')).toContain('high 5, low -5');
			expectNoBrokenNumbers(node);
		});
	});

	describe('lineChart', () => {
		const series = [
			{ label: 'Alerts', points: [{ hour: '13:00', count: 12 }, { hour: '14:00', count: 31 }, { hour: '15:00', count: 9 }] },
			{ label: 'Rejects', points: [{ hour: '13:00', count: 4 }, { hour: '14:00', count: 2 }, { hour: '15:00', count: 6 }] },
		];

		it('renders one polyline per series with adjacent-distinct series classes', () => {
			const node = charts.lineChart(series, { label: 'Alerts per hour', xKey: 'hour', yKey: 'count' });
			const lines = byTag(node, 'polyline');

			expect(lines).toHaveLength(2);
			expect(classesOf(lines[0])).toEqual(expect.arrayContaining(['chart-series-1']));
			expect(classesOf(lines[1])).toEqual(expect.arrayContaining(['chart-series-2']));
			expect(classesOf(lines[0])).not.toEqual(classesOf(lines[1]));
			expectNoBrokenNumbers(node);
		});

		it('states the time range and the peak hour in the aria-label', () => {
			const node = charts.lineChart(series, { label: 'Alerts per hour', xKey: 'hour', yKey: 'count' });
			const ariaLabel = svgOf(node).getAttribute('aria-label');

			expect(ariaLabel).toContain('Alerts per hour, from 13:00 to 15:00, 3 points.');
			expect(ariaLabel).toContain('Alerts: high 31 at 14:00, low 9 at 15:00.');
			expect(ariaLabel).toContain('Rejects: high 6 at 15:00, low 2 at 14:00.');
		});

		it('labels the x axis from xKey and keeps grid lines separate from data ink', () => {
			const node = charts.lineChart(series, { label: 'Alerts per hour', xKey: 'hour', yKey: 'count' });
			const axisLabels = byTag(node, 'text').map((text) => text.textContent);

			expect(axisLabels).toEqual(expect.arrayContaining(['13:00', '15:00']));
			expect(byTag(node, 'line').filter((line) => classesOf(line).includes('chart-grid-line')).length).toBeGreaterThan(0);
		});

		it('ships a data disclosure carrying the same numbers for every series point', () => {
			const node = charts.lineChart(series, { label: 'Alerts per hour', xKey: 'hour', yKey: 'count' });
			const details = byTag(node, 'details')[0];

			expect(byTag(details, 'summary')[0].textContent).toBe('Show data');
			expect(byTag(details, 'th').map((cell) => cell.textContent)).toEqual(['Series', 'hour', 'count']);
			expect(tableRows(details)).toEqual([
				['Alerts', '13:00', '12'],
				['Alerts', '14:00', '31'],
				['Alerts', '15:00', '9'],
				['Rejects', '13:00', '4'],
				['Rejects', '14:00', '2'],
				['Rejects', '15:00', '6'],
			]);
		});

		it('accepts a bare array of numbers per series without an xKey', () => {
			const node = charts.lineChart([{ label: 'Equity', values: [100, 140, 120] }], { label: 'Equity curve' });
			const headers = byTag(byTag(node, 'details')[0], 'th').map((cell) => cell.textContent);

			expect(headers).toEqual(['Series', 'Point', 'Value']);
			expect(byTag(node, 'polyline')).toHaveLength(1);
			expectNoBrokenNumbers(node);
		});

		it('handles a single point and a flat series without NaN geometry', () => {
			expect(() => charts.lineChart([{ label: 'One', points: [{ x: 1, y: 5 }] }], { xKey: 'x', yKey: 'y' })).not.toThrow();
			const flat = charts.lineChart([{ label: 'Flat', points: [{ x: 1, y: 4 }, { x: 2, y: 4 }] }], { xKey: 'x', yKey: 'y' });

			const circles = byTag(flat, 'circle');
			expect(new Set(circles.map((circle) => circle.getAttribute('cy'))).size).toBe(1);
			expectNoBrokenNumbers(flat);
		});

		it('plots negative values against a zero-anchored domain', () => {
			const node = charts.lineChart([{ label: 'PnL', points: [{ x: 1, y: -10 }, { x: 2, y: 20 }] }], { xKey: 'x', yKey: 'y' });

			expect(svgOf(node).getAttribute('aria-label')).toContain('high 20 at 2, low -10 at 1');
			expectNoBrokenNumbers(node);
		});

		it('skips non-finite samples instead of emitting a NaN coordinate', () => {
			const node = charts.lineChart([{ label: 'Gap', points: [{ x: 1, y: 3 }, { x: 2, y: undefined }, { x: 3, y: 5 }] }], { xKey: 'x', yKey: 'y' });

			expect(byTag(node, 'polyline')).toHaveLength(0);
			expect(byTag(node, 'circle')).toHaveLength(2);
			expect(tableRows(byTag(node, 'details')[0])).toEqual([
				['Gap', '1', '3'],
				['Gap', '2', '—'],
				['Gap', '3', '5'],
			]);
			expectNoBrokenNumbers(node);
		});

		it('widens the left gutter for a verbose y formatter so the tick text still fits inside it', () => {
			const gutterFor = (points, formatY) => {
				const node = charts.lineChart([{ label: 'Alerts', points }], { xKey: 'hour', yKey: 'count', formatY });
				const ticks = textBoxes(node).filter((item) => item.anchor === 'end');
				const gridStart = Number(byTag(node, 'line').find((line) => classesOf(line).includes('chart-grid-line')).getAttribute('x1'));
				const widest = Math.max(...ticks.map((item) => item.text.length * item.fontSize * 0.6));

				expect(widest).toBeLessThanOrEqual(gridStart - 8);
				return gridStart;
			};
			const small = [{ hour: '13:00', count: 3 }, { hour: '14:00', count: 42 }];
			const large = [{ hour: '13:00', count: 1234567 }, { hour: '14:00', count: 42 }];

			expect(gutterFor(small, (value) => String(value))).toBe(56);
			expect(gutterFor(large, (value) => `${value.toLocaleString('en-US')} alerts`)).toBeGreaterThan(56);
		});

		it('keeps every painted label inside the viewBox for a verbose y formatter', () => {
			const node = charts.lineChart([{ label: 'Alerts', points: [{ hour: '13:00', count: 1234567 }] }], {
				xKey: 'hour',
				yKey: 'count',
				formatY: (value) => `${value.toLocaleString('en-US')} alerts`,
			});
			const { width } = viewBoxOf(node);

			textBoxes(node).forEach((item) => {
				const estimatedWidth = item.text.length * item.fontSize * 0.6;
				const from = item.anchor === 'end' ? item.x - estimatedWidth : item.x - estimatedWidth / 2;

				expect(from).toBeGreaterThanOrEqual(0);
			});
			expect(viewBoxOf(node).width).toBe(width);
			expectNoBrokenNumbers(node);
		});
	});

	describe('barChart', () => {
		const categories = [
			{ label: 'BTCUSDT', alerts: 42 },
			{ label: 'ETHUSDT', alerts: 17 },
			{ label: 'SOLUSDT', alerts: 8 },
		];

		it('renders horizontal bars, category labels and value labels', () => {
			const node = charts.barChart(categories, { label: 'Alerts by symbol', valueKey: 'alerts' });
			const bars = byTag(node, 'rect');
			const labels = byTag(node, 'text').map((text) => text.textContent);

			expect(bars).toHaveLength(3);
			expect(classesOf(bars[0])).toEqual(expect.arrayContaining(['chart-bar-positive']));
			expect(labels).toEqual(expect.arrayContaining(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', '42', '17', '8']));
			expect(svgOf(node).getAttribute('role')).toBe('img');
			expect(svgOf(node).getAttribute('aria-label')).toContain('Alerts by symbol. 3 categories, high 42 at BTCUSDT, low 8 at SOLUSDT.');
		});

		it('falls back to a positional label when a category carries no name field', () => {
			const node = charts.barChart([{ alerts: 4 }, { alerts: 9 }], { valueKey: 'alerts' });
			const categoryLabels = byTag(node, 'text')
				.filter((text) => classesOf(text).includes('chart-category-text'))
				.map((text) => text.textContent);

			expect(categoryLabels).toEqual(['Category 1', 'Category 2']);
		});

		it('grows each bar from a shared zero baseline so widths are comparable', () => {
			const node = charts.barChart(categories, { valueKey: 'alerts' });
			const bars = byTag(node, 'rect');
			const widths = bars.map((bar) => Number(bar.getAttribute('width')));

			expect(widths[0]).toBeGreaterThan(widths[1]);
			expect(widths[1]).toBeGreaterThan(widths[2]);
			expect(new Set(bars.map((bar) => bar.getAttribute('x'))).size).toBe(1);
		});

		it('draws negative categories left of the zero line', () => {
			const node = charts.barChart([{ label: 'Loss', value: -30 }, { label: 'Win', value: 60 }], { valueKey: 'value' });
			const bars = byTag(node, 'rect');
			const zero = Number(bars[0].getAttribute('x')) + Number(bars[0].getAttribute('width'));

			expect(classesOf(bars[0])).toEqual(expect.arrayContaining(['chart-bar-negative']));
			expect(classesOf(bars[1])).toEqual(expect.arrayContaining(['chart-bar-positive']));
			expect(Number(bars[0].getAttribute('x'))).toBeLessThan(zero);
			expect(Number(bars[1].getAttribute('x'))).toBe(zero);
			expect(Number(bars[1].getAttribute('width'))).toBeGreaterThan(Number(bars[0].getAttribute('width')));
			expectNoBrokenNumbers(node);
		});

		it('renders a zero-length bar for an all-zero breakdown', () => {
			const node = charts.barChart([{ label: 'A', value: 0 }, { label: 'B', value: 0 }], { valueKey: 'value' });

			expect(byTag(node, 'rect').map((bar) => bar.getAttribute('width'))).toEqual(['0', '0']);
			expect(tableRows(byTag(node, 'details')[0])).toEqual([['A', '0'], ['B', '0']]);
			expectNoBrokenNumbers(node);
		});

		it('marks a non-finite category as missing instead of dropping it', () => {
			const node = charts.barChart([{ label: 'Known', value: 5 }, { label: 'Unknown', value: 'nope' }], { valueKey: 'value' });

			expect(byTag(node, 'rect')).toHaveLength(1);
			expect(byTag(node, 'text').map((text) => text.textContent)).toEqual(expect.arrayContaining(['—']));
			expect(tableRows(byTag(node, 'details')[0])).toEqual([['Known', '5'], ['Unknown', '—']]);
			expectNoBrokenNumbers(node);
		});

		it('treats a bare number array as values under positional labels', () => {
			const node = charts.barChart([5, 12, 3], { formatValue: (value) => `${value} alerts` });
			const categoryLabels = byTag(node, 'text')
				.filter((text) => classesOf(text).includes('chart-category-text'))
				.map((text) => text.textContent);

			expect(categoryLabels).toEqual(['Category 1', 'Category 2', 'Category 3']);
			expect(byTag(node, 'text').map((text) => text.textContent)).toEqual(expect.arrayContaining(['5 alerts', '12 alerts', '3 alerts']));
			expect(tableRows(byTag(node, 'details')[0])).toEqual([
				['Category 1', '5 alerts'],
				['Category 2', '12 alerts'],
				['Category 3', '3 alerts'],
			]);
			expectNoBrokenNumbers(node);
		});

		it('treats bare strings as unvalued labels so no bar invents a magnitude', () => {
			const node = charts.barChart(['BTCUSDT', 'ETHUSDT'], { valueKey: 'value' });
			const labels = byTag(node, 'text').map((text) => text.textContent);

			expect(labels).toEqual(expect.arrayContaining(['BTCUSDT', 'ETHUSDT', '—']));
			expect(byTag(node, 'rect')).toHaveLength(0);
			expect(tableRows(byTag(node, 'details')[0])).toEqual([['BTCUSDT', '—'], ['ETHUSDT', '—']]);
		});

		it('widens the left gutter for a long category label instead of painting it outside the figure', () => {
			const long = 'BINANCE:BTCUSDT-PERP-ALPHA-EXTREME';
			const node = charts.barChart([{ label: long, value: 5 }], { valueKey: 'value' });
			const { width } = viewBoxOf(node);
			const painted = textBoxes(node).find((item) => item.text.startsWith('BINANCE'));
			const estimatedWidth = painted.text.length * painted.fontSize * 0.6;

			expect(painted.anchor).toBe('end');
			expect(painted.x - estimatedWidth).toBeGreaterThan(0);
			expect(painted.x).toBeLessThan(width);
		});

		it('truncates an over-long category label on the graphic but keeps the full name in the table and aria-label', () => {
			const long = 'BINANCE:BTCUSDT-PERP-ALPHA-EXTREME';
			const node = charts.barChart([{ label: long, value: 5 }], { valueKey: 'value' });
			const painted = textBoxes(node).find((item) => item.anchor === 'end');

			expect(painted.text.length).toBeLessThan(long.length);
			expect(painted.text.endsWith('…')).toBe(true);
			expect(tableRows(byTag(node, 'details')[0])).toEqual([[long, '5']]);
			expect(svgOf(node).getAttribute('aria-label')).toContain(long);
		});

		it('grows the left gutter with the longest label and leaves short-label charts untouched', () => {
			const gutterFor = (label) => textBoxes(charts.barChart([{ label, value: 5 }], { valueKey: 'value' }))
				.find((item) => item.anchor === 'end').x;

			expect(gutterFor('BTCUSDT')).toBe(140);
			expect(gutterFor('BINANCE:BTCUSDT-PERP-ALPHA-EXTREME')).toBeGreaterThan(140);
		});

		it('widens the right gutter for a verbose value formatter so value labels stay inside', () => {
			const node = charts.barChart(
				[{ label: 'A', value: 1234567 }],
				{ valueKey: 'value', formatValue: (value) => `${value.toLocaleString('en-US')} alerts` },
			);
			const { width } = viewBoxOf(node);
			const painted = textBoxes(node).find((item) => item.text === '1,234,567 alerts' && item.anchor === 'start');

			expect(painted.x + painted.text.length * painted.fontSize * 0.6).toBeLessThan(width);
		});

		it('keeps a negative bar value label clear of its category name on the shared baseline', () => {
			const node = charts.barChart([
				{ label: 'FX_IDC:USDCLP(D)', value: -42 },
				{ label: 'BINANCE:BTCUSDT', value: 9 },
			], { valueKey: 'value', formatValue: (value) => `${value} alerts` });
			const boxes = textBoxes(node);
			const extent = (item) => {
				const w = item.text.length * item.fontSize * 0.6;

				return item.anchor === 'end' ? [item.x - w, item.x] : [item.x, item.x + w];
			};
			const names = boxes.filter((item) => item.text.endsWith('D)') || item.text === 'BINANCE:BTCUSDT');
			const negativeValue = boxes.find((item) => item.text === '-42 alerts');

			expect(negativeValue.anchor).toBe('end');
			const [nameLeft, nameRight] = extent(names[0]);
			const [valueLeft] = extent(negativeValue);
			expect(valueLeft).toBeGreaterThan(nameRight);
			expect(nameLeft).toBeGreaterThan(0);
		});

		it('keeps every painted label inside the viewBox for negatives, missing values and long names', () => {
			const node = charts.barChart([
				{ label: 'BINANCE:BTCUSDT-PERP-ALPHA-EXTREME', value: -1234567 },
				{ label: 'Missing', value: 'nope' },
				{ label: 'Zero', value: 0 },
			], { valueKey: 'value', formatValue: (value) => String(value) });
			const { width } = viewBoxOf(node);

			textBoxes(node).forEach((item) => {
				const estimatedWidth = item.text.length * item.fontSize * 0.6;
				const [from, to] = item.anchor === 'end'
					? [item.x - estimatedWidth, item.x]
					: item.anchor === 'middle'
						? [item.x - estimatedWidth / 2, item.x + estimatedWidth / 2]
						: [item.x, item.x + estimatedWidth];
				expect(from).toBeGreaterThanOrEqual(0);
				expect(to).toBeLessThanOrEqual(width);
			});
			expectNoBrokenNumbers(node);
		});
	});

	describe('donutChart', () => {
		it('renders arc slices, a total and a legend with matching shares', () => {
			const node = charts.donutChart([
				{ label: 'Delivered', value: 78 },
				{ label: 'Failed', value: 22 },
			], { label: 'Delivery outcome' });
			const slices = byTag(node, 'circle').filter((circle) => classesOf(circle).includes('chart-donut-slice'));

			expect(slices.map((slice) => slice.getAttribute('stroke-dasharray'))).toEqual(['78 22', '22 78']);
			expect(classesOf(slices[0])).toEqual(expect.arrayContaining(['chart-series-1']));
			expect(classesOf(slices[1])).toEqual(expect.arrayContaining(['chart-series-2']));
			expect(byTag(node, 'text').map((text) => text.textContent)).toEqual(expect.arrayContaining(['100', 'Delivery outcome']));
			expect(svgOf(node).getAttribute('aria-label')).toBe(
				'Delivery outcome. 2 slices, total 100. Delivered 78 (78.0%), Failed 22 (22.0%).',
			);
		});

		it('ships a legend and a data table with the same shares', () => {
			const node = charts.donutChart([
				{ label: 'Up', value: 3 },
				{ label: 'Down', value: 1 },
			], { label: 'Direction' });
			const legend = byTag(node, 'li').map((item) => item.textContent);

			expect(legend).toEqual(['Up3 · 75.0%', 'Down1 · 25.0%']);
			expect(tableRows(byTag(node, 'details')[0])).toEqual([['Up', '3', '75.0%'], ['Down', '1', '25.0%']]);
		});

		it('renders no arc and 0% shares for a zero total instead of dividing by zero', () => {
			const node = charts.donutChart([
				{ label: 'Queued', value: 0 },
				{ label: 'Failed', value: 0 },
			], { label: 'Queue' });

			expect(byTag(node, 'circle').filter((circle) => classesOf(circle).includes('chart-donut-slice'))).toHaveLength(0);
			expect(svgOf(node).getAttribute('aria-label')).toContain('total 0');
			expect(tableRows(byTag(node, 'details')[0])).toEqual([['Queued', '0', '0.0%'], ['Failed', '0', '0.0%']]);
			expectNoBrokenNumbers(node);
		});

		it('excludes negative shares from the arc but keeps them visible and labelled', () => {
			const node = charts.donutChart([
				{ label: 'Up', value: 10 },
				{ label: 'Reversal', value: -4 },
			], { label: 'Direction' });
			const slices = byTag(node, 'circle').filter((circle) => classesOf(circle).includes('chart-donut-slice'));

			expect(slices).toHaveLength(1);
			expect(slices[0].getAttribute('stroke-dasharray')).toBe('100 0');
			expect(svgOf(node).getAttribute('aria-label')).toContain('Reversal -4 (0.0%)');
			expect(tableRows(byTag(node, 'details')[0])).toEqual([['Up', '10', '100.0%'], ['Reversal', '-4', '0.0%']]);
			expectNoBrokenNumbers(node);
		});

		it('wraps series colours after six slices so adjacent slices differ', () => {
			const node = charts.donutChart(
				Array.from({ length: 8 }, (unused, index) => ({ label: `S${index + 1}`, value: index + 1 })),
				{ label: 'Many' },
			);
			const swatches = byTag(node, 'span').filter((span) => classesOf(span).includes('chart-legend-swatch'));

			expect(swatches.map((swatch) => classesOf(swatch).filter((name) => name.startsWith('chart-series-'))[0])).toEqual([
				'chart-series-1', 'chart-series-2', 'chart-series-3', 'chart-series-4',
				'chart-series-5', 'chart-series-6', 'chart-series-1', 'chart-series-2',
			]);
			expectNoBrokenNumbers(node);
		});
	});

	describe('empty input', () => {
		it('renders the existing .empty-state element with the caller message, never an empty svg', () => {
			const message = 'No alerts in the selected window.';
			const renderers = [
				() => charts.sparkline([], { emptyText: message }),
				() => charts.lineChart([], { emptyText: message }),
				() => charts.barChart([], { emptyText: message }),
				() => charts.donutChart([], { emptyText: message }),
			];

			renderers.forEach((render) => {
				const node = render();
				expect(node.tagName).toBe('P');
				expect(node.className).toBe('empty-state');
				expect(node.textContent).toBe(message);
				expect(byTag(node, 'svg')).toHaveLength(0);
			});
		});

		it('also treats non-array and series-without-points input as empty', () => {
			const renderers = [
				() => charts.sparkline(undefined, { emptyText: 'none' }),
				() => charts.sparkline('nope', { emptyText: 'none' }),
				() => charts.lineChart([{ label: 'Empty' }], { emptyText: 'none' }),
				() => charts.lineChart(null, { emptyText: 'none' }),
				() => charts.barChart({}, { emptyText: 'none' }),
				() => charts.donutChart(7, { emptyText: 'none' }),
			];

			renderers.forEach((render) => {
				expect(render().className).toBe('empty-state');
			});
		});

		it('falls back to a documented default message when the caller supplies none', () => {
			expect(charts.sparkline([]).textContent).toBe(charts.DEFAULT_EMPTY_TEXT);
			expect(charts.lineChart([]).textContent).toBe(charts.DEFAULT_EMPTY_TEXT);
			expect(charts.barChart([]).textContent).toBe(charts.DEFAULT_EMPTY_TEXT);
			expect(charts.donutChart([]).textContent).toBe(charts.DEFAULT_EMPTY_TEXT);
		});
	});

	describe('layout invariants', () => {
		const renderAll = (fresh) => [
			fresh.sparkline([1, 5, 3], { label: 'Spark' }),
			fresh.lineChart([{ label: 'Alerts', points: [{ x: 1, y: 3 }, { x: 2, y: 9 }] }], { xKey: 'x', yKey: 'y' }),
			fresh.barChart([{ label: 'BTCUSDT', value: 9 }, { label: 'ETHUSDT', value: 4 }], { valueKey: 'value' }),
			fresh.donutChart([{ label: 'Up', value: 9 }, { label: 'Down', value: 4 }]),
		];

		it('never applies .visually-hidden directly to a table in any chart', () => {
			const { charts: fresh } = loadCharts();

			renderAll(fresh).forEach((node) => {
				expect(tablesWithVisuallyHidden(node)).toEqual([]);
			});
		});

		it('parks .visually-hidden off the left edge so its own width can never widen the page', () => {
			// `width: 1px` is only a minimum for some display types, and leftward overflow does
			// not grow scrollWidth, so the offset is what makes the helper safe on any element.
			const rule = CSS.match(/^\.visually-hidden \{([^}]*)\}/m)[1];

			expect(rule).toMatch(/(?:^|;)\s*left:\s*-\d/);
			expect(rule).not.toMatch(/(?:^|;)\s*left:\s*auto/);
			expect(rule).toMatch(/(?:^|;)\s*top:\s*auto/);
		});

		it('puts line and bar graphics in a contained scroller with min-width:0 so overflow stays inside the card', () => {
			const { charts: fresh } = loadCharts();
			const [spark, line, bars, donut] = renderAll(fresh);
			const scrollerOf = (node) => node.children.find((child) => classesOf(child).includes('chart-scroll'));

			[line, bars].forEach((node) => {
				const scroller = scrollerOf(node);

				expect(scroller).toBeDefined();
				expect(svgOf(scroller)).toBeDefined();
				expect(svgOf(scroller).getAttribute('preserveAspectRatio')).toBe('xMinYMin meet');
			});
			expect(scrollerOf(spark)).toBeUndefined();
			expect(scrollerOf(donut)).toBeUndefined();
			expect(CSS).toMatch(/\.chart-scroll \{[^}]*min-width: 0/);
			expect(CSS).toMatch(/\.chart-scroll \{[^}]*overflow-x: auto/);
		});

		it('declares a minimum graphic width so axis text cannot scale below a readable size', () => {
			const rule = CSS.match(/\.chart-line-svg,\s*\.chart-bar-svg \{([^}]*)\}/)[1];
			const floor = Number(rule.match(/min-width:\s*([\d.]+)rem/)[1]);
			const viewBoxWidth = Number(SOURCE.match(/LINE_VIEWBOX = \{ width: (\d+)/)[1]);

			expect(floor * 16 / viewBoxWidth * 11).toBeGreaterThanOrEqual(8);
			expect(rule).toMatch(/max-width: none/);
		});

		// Every `.data-table` in admin.js except one is appended straight into a
		// `.dashboard-section`, which is a grid item with `min-width: auto`. An unbreakable
		// header there sets the page's min-content width instead of panning in a box: the
		// Outcomes "Performance by window" table measured 0px -> 468px of page-level
		// horizontal overflow at 375px. The harness has no layout engine, so this pins the
		// structural contract that keeps it unreachable rather than the rendered width.
		it('never puts an unbreakable header on a table that may render without a scroller', () => {
			const globalHeaderRule = CSS.match(/^\.data-table th \{([^}]*)\}/m)[1];

			expect(globalHeaderRule).not.toMatch(/white-space:\s*nowrap/);
		});

		it('scopes any nowrap data-table header to the scroller that can contain it', () => {
			const scoped = CSS.match(/^\.table-scroll \.data-table th \{([^}]*)\}/m);

			expect(scoped).not.toBeNull();
			expect(scoped[1]).toMatch(/white-space:\s*nowrap/);
			// The scroller is what makes the nowrap safe, so its own containment contract is
			// part of the same guarantee rather than a separate nicety.
			expect(CSS).toMatch(/\.table-scroll \{[^}]*min-width: 0/);
			expect(CSS).toMatch(/\.table-scroll \{[^}]*overflow(?:-x)?:\s*auto/);
		});
	});

	describe('CSP and asset constraints', () => {
		it('never touches innerHTML, outerHTML or insertAdjacentHTML while rendering', () => {
			const { charts: fresh } = loadCharts();
			const renderAll = () => {
				fresh.sparkline([1, 2, 3], { label: 'Spark' });
				fresh.lineChart([{ label: 'S', points: [{ x: 1, y: 1 }] }], { xKey: 'x', yKey: 'y' });
				fresh.barChart([{ label: 'C', value: 1 }], { valueKey: 'value' });
				fresh.donutChart([{ label: 'D', value: 1 }]);
			};

			expect(renderAll).not.toThrow();
			const probe = new FakeNode('div');
			FORBIDDEN_SINKS.forEach((sink) => {
				expect(() => {
					probe[sink] = '<svg onload="alert(1)"></svg>';
				}).toThrow(/must build DOM nodes only/);
				expect(() => probe[sink]).toThrow(/must build DOM nodes only/);
			});
			expect(() => createDocument().write).toThrow(/never inject markup/);
		});

		it('declares no inline markup sinks, remote URLs or external asset loads', () => {
			expect(SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
			expect(SOURCE).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
			expect(SOURCE).not.toMatch(/\b(?:fetch|import|importScripts|WebSocket|EventSource)\s*\(/);
		});

		it('emits no colour literals, leaving every colour to the CSS custom properties', () => {
			expect(SOURCE).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(SOURCE).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch|color-mix)\s*\(/);
		});

		it('routes every series through a chart-series-N class rather than inline paint', () => {
			const node = charts.lineChart(
				Array.from({ length: 3 }, (unused, index) => ({ label: `S${index + 1}`, points: [{ x: 1, y: index + 1 }, { x: 2, y: index + 2 }] })),
				{ xKey: 'x', yKey: 'y' },
			);

			walk(node, (current) => {
				const style = current.getAttribute && current.getAttribute('style');
				if (style !== null && style !== undefined) throw new Error(`Inline style found on ${current.tagName}: ${style}`);
				['fill', 'stroke', 'color', 'stop-color'].forEach((paint) => {
					expect(current.getAttribute(paint)).toBeNull();
				});
			});
		});

		it('loads as a plain defer script in the console shell before admin.js', () => {
			expect(SHELL).toMatch(/<script src="\/admin\/admin-charts\.js" defer><\/script>/);
			expect(SHELL.indexOf('/admin/admin-charts.js')).toBeLessThan(SHELL.indexOf('/admin/admin.js'));
		});
	});

	describe('design tokens', () => {
		it('defines every documented chart custom property in the existing :root block', () => {
			const root = CSS.slice(0, CSS.indexOf('\n}'));
			['--chart-surface', '--chart-grid', '--chart-axis'].forEach((token) => {
				expect(root).toContain(token);
			});
			for (let slot = 1; slot <= charts.SERIES_SLOTS; slot += 1) {
				expect(root).toMatch(new RegExp(`--chart-series-${slot}:\\s*#[0-9a-f]{6};`, 'i'));
			}
		});

		it('maps each series class to its token so CSS owns every colour', () => {
			for (let slot = 1; slot <= charts.SERIES_SLOTS; slot += 1) {
				expect(CSS).toContain(`.chart-series-${slot} { --chart-series-color: var(--chart-series-${slot}); }`);
			}
			expect(CSS).toMatch(/\.chart-axis-text[^{]*\{\s*fill:\s*var\(--chart-axis\)/);
			expect(CSS).toMatch(/\.chart-grid-line \{\s*stroke:\s*var\(--chart-grid\)/);
		});

		it('provides the accessibility helper class the hidden sparkline table relies on', () => {
			expect(CSS).toMatch(/^\.visually-hidden \{[^}]*clip-path: inset\(50%\)/m);
		});
	});

	describe('build output parity', () => {
		it('keeps public/admin/admin-charts.js byte-identical to the source file', () => {
			const built = path.join(__dirname, '../../public/admin/admin-charts.js');
			expect(fs.existsSync(built)).toBe(true);
			expect(fs.readFileSync(built, 'utf8')).toBe(SOURCE);
		});

		it('keeps public/admin/admin.css byte-identical to the source stylesheet', () => {
			const built = path.join(__dirname, '../../public/admin/admin.css');
			expect(fs.existsSync(built)).toBe(true);
			expect(fs.readFileSync(built, 'utf8')).toBe(CSS);
		});
	});
});