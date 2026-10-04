'use strict';

/* global document, window */

// CSP-safe SVG chart primitives for the operator console.
// Every visual is built with createElementNS + setAttribute and DOM text nodes, so the
// console keeps working under the strict helmet CSP in app.js (no inline script, no eval,
// no external asset). Colours live in CSS custom properties only — this module never
// emits a hex literal.
(function exposeCharts(root, factory) {
	const api = factory();

	if (typeof module === 'object' && module.exports) {
		module.exports = api;
		return;
	}

	root.CabrosAdminCharts = api;
}(typeof window === 'undefined' ? globalThis : window, () => {
	const SVG_NS = 'http://www.w3.org/2000/svg';
	// Series colours cycle through six slots so adjacent series never share a hue.
	const SERIES_SLOTS = 6;
	const SPARKLINE_VIEWBOX = { width: 120, height: 32 };
	const LINE_VIEWBOX = { width: 720, height: 280 };
	const BAR_VIEWBOX = { width: 720 };
	const BAR_ROW_HEIGHT = 34;
	const DONUT_VIEWBOX = { width: 320, height: 220 };
	const DEFAULT_EMPTY_TEXT = 'No data available to chart.';
	const MISSING = '—';

	const applyAttributes = (node, attributes = {}) => {
		Object.entries(attributes).forEach(([name, value]) => {
			if (value !== undefined && value !== null && value !== '') node.setAttribute(name, String(value));
		});
		return node;
	};

	const htmlElement = (tag, className, text) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = String(text);
		return node;
	};

	const svgElement = (tag, attributes = {}) => applyAttributes(
		document.createElementNS(SVG_NS, tag),
		attributes,
	);

	const svgText = (content, attributes = {}, className = 'chart-axis-text') => {
		const node = svgElement('text', { class: className, ...attributes });
		node.textContent = String(content);
		return node;
	};

	// Non-numeric API values collapse to null so a gap is drawn instead of NaN geometry.
	const toFinite = (value) => {
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		if (typeof value === 'string' && value.trim() !== '') {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	};

	const formatNumber = (value) => {
		const numeric = toFinite(value);
		if (numeric === null) return MISSING;
		return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(2)));
	};

	const formatter = (fn) => (typeof fn === 'function' ? fn : formatNumber);

	const displayText = (value) => {
		if (value === null || value === undefined || value === '') return MISSING;
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	};

	// "category" and "slice" do not pluralise by appending "s".
	const PLURALS = { category: 'categories', point: 'points', slice: 'slices' };

	const plural = (count, singular) => `${count} ${count === 1 ? singular : PLURALS[singular] || `${singular}s`}`;

	const seriesClass = (index) => `chart-series-${(Math.max(0, Math.trunc(index) || 0) % SERIES_SLOTS) + 1}`;

	const round = (value) => Math.round(value * 100) / 100;

	const emptyState = (message) => htmlElement('p', 'empty-state', message || DEFAULT_EMPTY_TEXT);

	// Midpoint fallback keeps a zero-range domain off the division path entirely.
	const scale = (value, min, max, rangeMin, rangeMax) => (max === min
		? (rangeMin + rangeMax) / 2
		: rangeMin + ((value - min) / (max - min)) * (rangeMax - rangeMin));

	// Single pass rather than Math.min(...values): spreading a long series into the call
	// stack overflows, and this runs on operator data of unbounded size.
	const extent = (values) => {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		values.forEach((value) => {
			if (value === null || !Number.isFinite(value)) return;
			if (value < min) min = value;
			if (value > max) max = value;
		});
		return min > max ? { min: 0, max: 0 } : { min, max };
	};

	const niceTicks = (min, max, count = 4) => {
		if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
		const step = Math.max((max - min) / Math.max(1, count), Number.EPSILON);
		const ticks = [];
		for (let tick = Math.ceil(min / step) * step; tick <= max + step / 2 && ticks.length < 12; tick += step) {
			ticks.push(Number(tick.toPrecision(12)));
		}
		return ticks.length ? ticks : [min, max];
	};

	const describeExtremes = (points, format) => {
		const present = points.filter((point) => point.value !== null);
		if (!present.length) return 'no plottable values';
		const high = present.reduce((best, point) => (point.value > best.value ? point : best));
		const low = present.reduce((best, point) => (point.value < best.value ? point : best));
		const highLabel = `${format(high.value)}${high.at === undefined || high.at === null ? '' : ` at ${displayText(high.at)}`}`;
		const lowLabel = `${format(low.value)}${low.at === undefined || low.at === null ? '' : ` at ${displayText(low.at)}`}`;
		return `high ${highLabel}, low ${lowLabel}`;
	};

	const dataTable = (caption, headers, rows, className = 'chart-data-table') => {
		const table = htmlElement('table', className);
		table.append(htmlElement('caption', null, caption));
		const head = htmlElement('thead');
		const headRow = htmlElement('tr');
		headers.forEach((header) => headRow.append(htmlElement('th', null, header)));
		head.append(headRow);
		const body = htmlElement('tbody');
		rows.forEach((cells) => {
			const row = htmlElement('tr');
			cells.forEach((cell) => row.append(htmlElement('td', null, cell)));
			body.append(row);
		});
		table.append(head, body);
		return table;
	};

	// Sparklines stay inline inside KPI cards, so their equivalent table is visually hidden
	// rather than adding a disclosure to every card. The other charts get a <details>.
	const disclosure = (caption, headers, rows) => {
		const details = htmlElement('details', 'chart-data');
		details.append(
			htmlElement('summary', null, 'Show data'),
			dataTable(caption, headers, rows),
		);
		return details;
	};

	const figure = (className, children) => {
		const node = htmlElement('figure', className);
		node.append(...children);
		return node;
	};

	const sparkline = (values, options = {}) => {
		const list = Array.isArray(values) ? values : [];
		if (!list.length) return emptyState(options.emptyText);
		const points = list.map((value, index) => ({ index, value: toFinite(value) }));
		const { min, max } = extent(points.map((point) => point.value));
		const label = options.label || 'Series';
		const format = formatter(options.formatValue);
		const { width, height } = SPARKLINE_VIEWBOX;
		const x = (index) => (points.length === 1 ? width / 2 : scale(index, 0, points.length - 1, 1, width - 1));
		const y = (value) => scale(value, min, max, height - 2, 2);

		const svg = svgElement('svg', {
			class: 'chart-svg chart-sparkline-svg',
			viewBox: `0 0 ${width} ${height}`,
			width: '100%',
			height,
			preserveAspectRatio: 'none',
			role: 'img',
			'aria-label': `${label}. ${plural(points.length, 'point')}, ${describeExtremes(points, format)}, latest ${format(points[points.length - 1].value)}.`,
		});

		// Non-finite samples split the line into separate runs instead of a NaN coordinate.
		let run = [];
		const flushRun = () => {
			if (run.length >= 2) {
				svg.append(svgElement('polyline', {
					class: 'chart-sparkline-line',
					points: run.map((entry) => `${round(entry.x)},${round(entry.y)}`).join(' '),
				}));
			}
			run = [];
		};
		points.forEach((point, index) => {
			if (point.value === null) {
				flushRun();
				return;
			}
			run.push({ x: x(index), y: y(point.value) });
		});
		flushRun();

		points.forEach((point, index) => {
			if (point.value === null) return;
			svg.append(svgElement('circle', {
				class: 'chart-sparkline-point',
				cx: round(x(index)),
				cy: round(y(point.value)),
				r: points.length === 1 ? 2.4 : 1.6,
			}));
		});

		return figure('chart-figure chart-figure-inline', [
			svg,
			dataTable(`${label} values`, ['Point', 'Value'], points.map((point) => [
				String(point.index + 1),
				format(point.value),
			]), 'chart-data-table visually-hidden'),
		]);
	};

	const normalizeSeries = (input, xKey, yKey) => (Array.isArray(input) ? input : []).map((entry, index) => {
		const name = String(entry?.label ?? entry?.name ?? `Series ${index + 1}`);
		const points = Array.isArray(entry?.points) ? entry.points : Array.isArray(entry?.values) ? entry.values : [];
		return {
			label: name,
			points: points.map((item, position) => (item !== null && typeof item === 'object'
				? { x: xKey ? item[xKey] : position + 1, value: toFinite(item[yKey]) }
				: { x: position + 1, value: toFinite(item) })),
		};
	});

	const lineChart = (series, options = {}) => {
		const list = normalizeSeries(series, options.xKey, options.yKey);
		if (!list.length || !list.some((entry) => entry.points.length)) return emptyState(options.emptyText);
		const xKey = options.xKey;
		const yKey = options.yKey;
		const formatY = formatter(options.formatY);
		const label = options.label || 'Series over time';
		const { width, height } = LINE_VIEWBOX;
		const pad = { top: 16, right: 18, bottom: 34, left: 56 };
		const plotWidth = width - pad.left - pad.right;
		const plotHeight = height - pad.top - pad.bottom;
		const longest = list.reduce((widest, entry) => Math.max(widest, entry.points.length), 0);

		const { min: dataMin, max: dataMax } = extent(list.flatMap((entry) => entry.points.map((point) => point.value)));
		// A flat series gets a symmetric domain so the line sits centred instead of pinned
		// to an edge; otherwise the domain always reaches zero so magnitudes stay honest.
		const flat = dataMax === dataMin;
		const min = flat ? dataMin - 1 : Math.min(0, dataMin);
		const max = flat ? dataMax + 1 : dataMax;
		const y = (value) => scale(value, min, max, pad.top + plotHeight, pad.top);
		const x = (index) => scale(index, 0, Math.max(1, longest - 1), pad.left, pad.left + plotWidth);

		const axisSeries = list.reduce((widest, entry) => (entry.points.length > widest.points.length ? entry : widest), list[0]);
		const rangeText = xKey && axisSeries.points.length
			? `from ${displayText(axisSeries.points[0].x)} to ${displayText(axisSeries.points[axisSeries.points.length - 1].x)}, `
			: '';
		const summary = list.map((entry) => `${entry.label}: ${describeExtremes(
			entry.points.map((point) => (xKey ? { value: point.value, at: point.x } : point)),
			formatY,
		)}`).join('. ');

		const svg = svgElement('svg', {
			class: 'chart-svg chart-line-svg',
			viewBox: `0 0 ${width} ${height}`,
			width: '100%',
			height,
			role: 'img',
			'aria-label': `${label}, ${rangeText}${plural(longest, 'point')}. ${summary}.`,
		});

		niceTicks(min, max).forEach((tick) => {
			svg.append(svgElement('line', {
				class: 'chart-grid-line',
				x1: pad.left,
				x2: pad.left + plotWidth,
				y1: round(y(tick)),
				y2: round(y(tick)),
			}));
			svg.append(svgText(formatY(tick), { x: 0, y: round(y(tick)) + 4, 'text-anchor': 'end' }));
		});

		svg.append(svgElement('line', {
			class: 'chart-axis-line',
			x1: pad.left,
			x2: pad.left + plotWidth,
			y1: pad.top + plotHeight,
			y2: pad.top + plotHeight,
		}));

		[0, axisSeries.points.length - 1].forEach((position) => {
			const point = axisSeries.points[position];
			if (!point) return;
			svg.append(svgText(displayText(point.x), {
				x: round(x(position)),
				y: pad.top + plotHeight + 18,
				'text-anchor': position === 0 ? 'start' : 'end',
			}));
		});

		list.forEach((entry, seriesIndex) => {
			const className = seriesClass(seriesIndex);
			let run = [];
			const flushRun = () => {
				if (run.length >= 2) {
					svg.append(svgElement('polyline', {
						class: `chart-line ${className}`,
						points: run.map((part) => `${round(part.x)},${round(part.y)}`).join(' '),
					}));
				}
				run = [];
			};
			entry.points.forEach((point, position) => {
				if (point.value === null) {
					flushRun();
					return;
				}
				run.push({ x: x(position), y: y(point.value) });
				svg.append(svgElement('circle', {
					class: `chart-point ${className}`,
					cx: round(x(position)),
					cy: round(y(point.value)),
					r: 2.6,
				}));
			});
			flushRun();
		});

		return figure('chart-figure', [
			svg,
			disclosure(label, ['Series', xKey || 'Point', yKey || 'Value'], list.flatMap((entry) => entry.points.map((point) => [
				entry.label,
				displayText(point.x),
				formatY(point.value),
			]))),
		]);
	};

	const categoryName = (entry, index) => {
		// A bare string is a label with no magnitude; a bare number is a magnitude with no
		// label, so it gets a positional name instead of being printed as its own heading.
		if (typeof entry === 'string') return entry;
		if (typeof entry !== 'object' || entry === null) return `Category ${index + 1}`;
		// Only explicit name fields count. Falling back to the value field here would print
		// the bar's own magnitude as its label, which reads as duplicated data.
		const name = entry.label ?? entry.name;
		return name === undefined || name === null || name === '' ? `Category ${index + 1}` : String(name);
	};

	const barChart = (categories, options = {}) => {
		const list = Array.isArray(categories) ? categories : [];
		if (!list.length) return emptyState(options.emptyText);
		const valueKey = options.valueKey || 'value';
		const formatValue = formatter(options.formatValue);
		const label = options.label || 'Breakdown by category';
		const rows = list.map((entry, index) => ({
			name: categoryName(entry, index),
			value: toFinite(typeof entry === 'object' && entry !== null ? entry[valueKey] : entry),
		}));
		const { min: dataMin, max: dataMax } = extent(rows.map((row) => row.value));
		// Anchoring the domain on zero lets negative categories grow leftwards instead of
		// inverting the scale, and keeps a zero category a truthful zero-length bar.
		const min = Math.min(0, dataMin);
		const max = Math.max(0, dataMax);
		const { width } = BAR_VIEWBOX;
		const pad = { top: 12, right: 72, bottom: 26, left: 150 };
		// Height follows the row count so a three-category breakdown does not render inside
		// a mostly empty 280px box.
		const height = pad.top + rows.length * BAR_ROW_HEIGHT + pad.bottom;
		const plotWidth = width - pad.left - pad.right;
		const trackHeight = Math.max(6, BAR_ROW_HEIGHT - 16);
		const zero = scale(0, min, max, pad.left, pad.left + plotWidth);

		const svg = svgElement('svg', {
			class: 'chart-svg chart-bar-svg',
			viewBox: `0 0 ${width} ${height}`,
			width: '100%',
			height,
			role: 'img',
			'aria-label': `${label}. ${plural(rows.length, 'category')}, ${describeExtremes(rows.map((row) => ({ value: row.value, at: row.name })), formatValue)}.`,
		});

		niceTicks(min, max).forEach((tick) => {
			const position = round(scale(tick, min, max, pad.left, pad.left + plotWidth));
			svg.append(svgElement('line', {
				class: 'chart-grid-line',
				x1: position,
				x2: position,
				y1: pad.top,
				y2: height - pad.bottom,
			}));
			svg.append(svgText(formatValue(tick), {
				x: position,
				y: height - pad.bottom + 15,
				'text-anchor': 'middle',
			}));
		});

		rows.forEach((row, index) => {
			const top = pad.top + index * BAR_ROW_HEIGHT;
			const baseline = top + trackHeight / 2 + 4;
			svg.append(svgText(row.name, { x: pad.left - 10, y: baseline, 'text-anchor': 'end' }, 'chart-category-text'));
			if (row.value === null) {
				svg.append(svgText(MISSING, { x: zero + 8, y: baseline }));
				return;
			}
			const end = scale(row.value, min, max, pad.left, pad.left + plotWidth);
			const left = Math.min(zero, end);
			const barWidth = Math.abs(end - zero);
			svg.append(svgElement('rect', {
				class: `chart-bar chart-bar-${row.value < 0 ? 'negative' : 'positive'}`,
				x: round(left),
				y: top,
				width: round(barWidth),
				height: trackHeight,
				rx: 3,
			}));
			svg.append(svgText(formatValue(row.value), {
				x: row.value < 0 ? left - 6 : left + barWidth + 6,
				y: baseline,
				'text-anchor': row.value < 0 ? 'end' : 'start',
			}));
		});

		return figure('chart-figure', [
			svg,
			disclosure(label, ['Category', valueKey], rows.map((row) => [row.name, formatValue(row.value)])),
		]);
	};

	const sliceName = (entry, index) => {
		if (typeof entry !== 'object' || entry === null) return String(entry);
		const name = entry.label ?? entry.name;
		return name === undefined || name === null || name === '' ? `Slice ${index + 1}` : String(name);
	};

	const sliceValue = (entry) => {
		if (typeof entry !== 'object' || entry === null) return toFinite(entry);
		return toFinite(entry.value ?? entry.count ?? entry.total);
	};

	const donutChart = (slices, options = {}) => {
		const list = Array.isArray(slices) ? slices : [];
		if (!list.length) return emptyState(options.emptyText);
		const label = options.label || 'Share by slice';
		const rows = list.map((entry, index) => ({ name: sliceName(entry, index), value: sliceValue(entry) }));
		// A negative share is meaningless as arc geometry, so only positives contribute to
		// the ring while every slice stays visible in the legend and the data table.
		const total = rows.reduce((sum, row) => sum + (row.value !== null && row.value > 0 ? row.value : 0), 0);
		const shares = rows.map((row) => ({
			...row,
			share: total > 0 && row.value !== null && row.value > 0 ? (row.value / total) * 100 : 0,
		}));
		const { width, height } = DONUT_VIEWBOX;
		const radius = 70;
		const centre = { x: 110, y: 110 };
		const totalText = formatNumber(total);

		const svg = svgElement('svg', {
			class: 'chart-svg chart-donut-svg',
			viewBox: `0 0 ${width} ${height}`,
			width: '100%',
			height,
			role: 'img',
			'aria-label': `${label}. ${plural(rows.length, 'slice')}, total ${totalText}. ${shares.map((slice) => `${slice.name} ${formatNumber(slice.value)} (${slice.share.toFixed(1)}%)`).join(', ')}.`,
		});

		svg.append(svgElement('circle', {
			class: 'chart-donut-track',
			cx: centre.x,
			cy: centre.y,
			r: radius,
			pathLength: '100',
		}));

		let offset = 0;
		shares.forEach((slice, index) => {
			if (slice.share <= 0) return;
			svg.append(svgElement('circle', {
				class: `chart-donut-slice ${seriesClass(index)}`,
				cx: centre.x,
				cy: centre.y,
				r: radius,
				pathLength: '100',
				'stroke-dasharray': `${round(slice.share)} ${round(100 - slice.share)}`,
				'stroke-dashoffset': String(round(-offset)),
			}));
			offset += slice.share;
		});

		svg.append(svgText(totalText, { x: centre.x, y: centre.y + 2, 'text-anchor': 'middle' }, 'chart-donut-total'));
		svg.append(svgText(label, { x: centre.x, y: centre.y + 20, 'text-anchor': 'middle' }, 'chart-donut-caption'));

		const legend = htmlElement('ul', 'chart-legend');
		shares.forEach((slice, index) => {
			const item = htmlElement('li', 'chart-legend-item');
			item.append(htmlElement('span', `chart-legend-swatch ${seriesClass(index)}`));
			item.append(htmlElement('span', 'chart-legend-label', slice.name));
			item.append(htmlElement('span', 'chart-legend-value', `${formatNumber(slice.value)} · ${slice.share.toFixed(1)}%`));
			legend.append(item);
		});

		return figure('chart-figure', [
			svg,
			legend,
			disclosure(label, ['Slice', 'Value', 'Share'], shares.map((slice) => [
				slice.name,
				formatNumber(slice.value),
				`${slice.share.toFixed(1)}%`,
			])),
		]);
	};

	return {
		DEFAULT_EMPTY_TEXT,
		SERIES_SLOTS,
		barChart,
		donutChart,
		lineChart,
		sparkline,
	};
}));