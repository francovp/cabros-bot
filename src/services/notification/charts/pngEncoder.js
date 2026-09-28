'use strict';

const zlib = require('zlib');

/**
 * Minimal dependency-free PNG encoder.
 *
 * Implements only what the chart renderer needs: 8-bit truecolour-with-alpha
 * (colour type 6) non-interlaced PNGs. Using `zlib` from the Node standard
 * library avoids pulling a native canvas binding (cairo/pango) into the
 * production image just to draw a few dozen lines.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let crc = -1;
	for (let i = 0; i < buffer.length; i += 1) {
		crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ -1) >>> 0;
}

function buildChunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData), 0);
	return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Build the per-scanline filter byte + RGBA payload expected by the PNG IDAT stream.
 * Filter type 0 (None) keeps the encoder trivial; deflate handles the redundancy
 * well enough for flat-colour chart backgrounds.
 */
function buildRawScanlines(pixels, width, height) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const rowStart = y * (stride + 1);
		raw[rowStart] = 0; // filter: None
		pixels.copy(raw, rowStart + 1, y * stride, y * stride + stride);
	}
	return raw;
}

function buildIhdr(width, height) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.writeUInt8(8, 8); // bit depth
	ihdr.writeUInt8(6, 9); // colour type: truecolour with alpha
	ihdr.writeUInt8(0, 10); // compression: deflate
	ihdr.writeUInt8(0, 11); // filter: adaptive
	ihdr.writeUInt8(0, 12); // interlace: none
	return ihdr;
}

/**
 * Encode an RGBA pixel buffer as a PNG.
 *
 * @param {Buffer} pixels RGBA bytes, `width * height * 4` long.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG file bytes.
 */
function encodePng(pixels, width, height) {
	if (!Buffer.isBuffer(pixels)) {
		throw new TypeError('encodePng requires a Buffer of RGBA pixels');
	}
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new RangeError('encodePng requires positive integer width/height');
	}
	const expected = width * height * 4;
	if (pixels.length !== expected) {
		throw new RangeError(`encodePng expected ${expected} RGBA bytes, received ${pixels.length}`);
	}

	return Buffer.concat([
		PNG_SIGNATURE,
		buildChunk('IHDR', buildIhdr(width, height)),
		buildChunk('IDAT', zlib.deflateSync(buildRawScanlines(pixels, width, height), { level: 9 })),
		buildChunk('IEND', Buffer.alloc(0)),
	]);
}

module.exports = { encodePng };
