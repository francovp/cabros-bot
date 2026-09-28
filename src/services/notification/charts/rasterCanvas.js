'use strict';

/**
 * Tiny RGBA raster canvas: the minimal drawing primitives the chart renderer
 * needs (filled rect, line, polyline, dashed line, text) without a native
 * dependency. All coordinates are integer device pixels; callers are expected
 * to pass already-clamped values.
 */

const PALETTE = Object.freeze({
	background: [17, 24, 39, 255], // slate-900
	gridLine: [55, 65, 81, 255], // slate-700
	border: [75, 85, 99, 255], // slate-600
	up: [34, 197, 94, 255], // green-500
	down: [239, 68, 68, 255], // red-500
	neutral: [148, 163, 184, 255], // slate-400
	volumeUp: [34, 197, 94, 90],
	volumeDown: [239, 68, 68, 90],
	text: [226, 232, 240, 255], // slate-200
	accent: [56, 189, 248, 255], // sky-400
	entry: [56, 189, 248, 255],
	target: [34, 197, 94, 255],
	stop: [239, 68, 68, 255],
});

// 5x7 bitmap font covering the glyphs used in chart labels. Anything outside
// the table renders as a filled box so a missing glyph is visible rather than
// silently blank.
const FONT = Object.freeze({
	'0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
	'1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
	'2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
	'3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
	'4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
	'5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
	'6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
	'7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
	'8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
	'9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
	'.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
	',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
	':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
	'-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
	'%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
	'/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
	'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
	'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
	'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
	'D': ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
	'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
	'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
	'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
	'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
	'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
	'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
	'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
	'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
	'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
	'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
	'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
	'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
	'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
	'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
	'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
	'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
	'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
	'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
	'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
	'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
	'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
	'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
	' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
	'?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
	'#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
	'(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
	')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
});

const FONT_HEIGHT = 7;
const FONT_WIDTH = 5;
const FONT_SPACING = 1;
const FONT_ADVANCE = FONT_WIDTH + FONT_SPACING;

class RasterCanvas {
	constructor(width, height, background = PALETTE.background) {
		if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
			throw new RangeError('RasterCanvas requires positive integer width/height');
		}
		this.width = width;
		this.height = height;
		this.pixels = Buffer.alloc(width * height * 4);
		this.fillRect(0, 0, width, height, background);
	}

	/**
	 * Alpha-blend a single pixel. Coordinates outside the canvas are ignored.
	 */
	setPixel(x, y, [r, g, b, a]) {
		const px = x | 0;
		const py = y | 0;
		if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
		if (a >= 255) {
			const offset = (py * this.width + px) * 4;
			this.pixels[offset] = r;
			this.pixels[offset + 1] = g;
			this.pixels[offset + 2] = b;
			this.pixels[offset + 3] = 255;
			return;
		}
		if (a <= 0) return;
		const offset = (py * this.width + px) * 4;
		const alpha = a / 255;
		const inv = 1 - alpha;
		this.pixels[offset] = Math.round(r * alpha + this.pixels[offset] * inv);
		this.pixels[offset + 1] = Math.round(g * alpha + this.pixels[offset + 1] * inv);
		this.pixels[offset + 2] = Math.round(b * alpha + this.pixels[offset + 2] * inv);
		this.pixels[offset + 3] = Math.max(this.pixels[offset + 3], a);
	}

	fillRect(x, y, width, height, color) {
		const x0 = Math.max(0, Math.round(x));
		const y0 = Math.max(0, Math.round(y));
		const x1 = Math.min(this.width, Math.round(x + width));
		const y1 = Math.min(this.height, Math.round(y + height));
		for (let py = y0; py < y1; py += 1) {
			for (let px = x0; px < x1; px += 1) {
				this.setPixel(px, py, color);
			}
		}
	}

	strokeRect(x, y, width, height, color, thickness = 1) {
		this.fillRect(x, y, width, thickness, color);
		this.fillRect(x, y + height - thickness, width, thickness, color);
		this.fillRect(x, y, thickness, height, color);
		this.fillRect(x + width - thickness, y, thickness, height, color);
	}

	/**
	 * Draw a line with Bresenham's algorithm, optionally `thickness` px wide.
	 */
	line(x0, y0, x1, y1, color, thickness = 1) {
		const startX = Math.round(x0);
		const startY = Math.round(y0);
		const endX = Math.round(x1);
		const endY = Math.round(y1);
		const dx = Math.abs(endX - startX);
		const dy = -Math.abs(endY - startY);
		const stepsX = startX < endX ? 1 : -1;
		const stepsY = startY < endY ? 1 : -1;
		let error = dx + dy;
		let x = startX;
		let y = startY;
		const half = Math.max(0, Math.floor((thickness - 1) / 2));
		// Guard against pathological coordinates producing an unbounded loop.
		const maxSteps = this.width + this.height + 2;
		let steps = 0;
		while (steps <= maxSteps) {
			if (thickness <= 1) {
				this.setPixel(x, y, color);
			} else {
				this.fillRect(x - half, y - half, thickness, thickness, color);
			}
			if (x === endX && y === endY) break;
			const doubled = 2 * error;
			if (doubled >= dy) {
				error += dy;
				x += stepsX;
			}
			if (doubled <= dx) {
				error += dx;
				y += stepsY;
			}
			steps += 1;
		}
	}

	polyline(points, color, thickness = 1) {
		for (let i = 1; i < points.length; i += 1) {
			this.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], color, thickness);
		}
	}

	dashedLine(x0, y0, x1, y1, color, thickness = 1, dashLength = 4) {
		const totalLength = Math.hypot(x1 - x0, y1 - y0);
		if (totalLength === 0) return;
		const stepX = (x1 - x0) / totalLength;
		const stepY = (y1 - y0) / totalLength;
		let travelled = 0;
		let draw = true;
		while (travelled < totalLength) {
			const segmentEnd = Math.min(travelled + dashLength, totalLength);
			if (draw) {
				this.line(
					x0 + stepX * travelled, y0 + stepY * travelled,
					x0 + stepX * segmentEnd, y0 + stepY * segmentEnd,
					color, thickness,
				);
			}
			draw = !draw;
			travelled = segmentEnd;
		}
	}

	/**
	 * Draw uppercase text using the built-in 5x7 bitmap font.
	 * @returns {number} the advance width consumed (so callers can chain labels).
	 */
	text(value, x, y, color = PALETTE.text, scale = 1) {
		const normalized = String(value == null ? '' : value).toUpperCase();
		let cursor = Math.round(x);
		for (const char of normalized) {
			const glyph = FONT[char] || FONT['?'];
			for (let row = 0; row < FONT_HEIGHT; row += 1) {
				const bits = glyph[row];
				for (let col = 0; col < FONT_WIDTH; col += 1) {
					if (bits[col] !== '1') continue;
					this.fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
				}
			}
			cursor += FONT_ADVANCE * scale;
		}
		return cursor - Math.round(x);
	}

	static measureText(value, scale = 1) {
		const normalized = String(value == null ? '' : value).toUpperCase();
		if (normalized.length === 0) return 0;
		return normalized.length * FONT_ADVANCE * scale - FONT_SPACING * scale;
	}

	static get textHeight() {
		return FONT_HEIGHT;
	}
}

module.exports = { RasterCanvas, PALETTE };
