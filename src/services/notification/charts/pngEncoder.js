/**
 * pngEncoder - minimal, dependency-free PNG encoder.
 *
 * Encodes 8-bit grayscale or RGBA pixel buffers as a valid PNG (IHDR + IDAT +
 * IEND chunks, zlib-compressed via Node's built-in zlib module). Used by the
 * chart renderer to produce Telegram sendPhoto-compatible PNG buffers without
 * pulling in native canvas/sharp dependencies.
 *
 * Scope: small (<=1024x1024) charts such as sparklines and candlesticks. Not
 * intended as a general-purpose image library.
 *
 * Fail-open: every public method returns null on invalid input so callers
 * can fall through to a text-only delivery path.
 */

'use strict';

const zlib = require('zlib');

const MAX_DIMENSION = 1024;
const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function computeCrc32(buffer) {
	let crc = 0xffffffff;
	for (let i = 0; i < buffer.length; i += 1) {
		crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeBuffer = Buffer.from(type, 'ascii');
	const crcBuffer = Buffer.alloc(4);
	crcBuffer.writeUInt32BE(computeCrc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePngBuffer({ width, height, channels, pixelData }) {
	const colorType = channels === 4 ? 6 : 0;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = colorType;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const stride = width * channels;
	const filtered = Buffer.alloc((stride + 1) * height);
	for (let row = 0; row < height; row += 1) {
		filtered[row * (stride + 1)] = 0;
		pixelData.copy(filtered, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
	}
	const idatData = zlib.deflateSync(filtered);

	return Buffer.concat([
		PNG_SIGNATURE,
		createChunk('IHDR', ihdr),
		createChunk('IDAT', idatData),
		createChunk('IEND', Buffer.alloc(0)),
	]);
}

function encodeRgba({ width, height, pixels }) {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		return null;
	}
	if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
		return null;
	}
	if (!Buffer.isBuffer(pixels) || pixels.length !== width * height * 4) {
		return null;
	}
	return encodePngBuffer({ width, height, channels: 4, pixelData: pixels });
}

function encodeGrayscale({ width, height, pixels }) {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		return null;
	}
	if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
		return null;
	}
	if (!Buffer.isBuffer(pixels) || pixels.length !== width * height) {
		return null;
	}
	return encodePngBuffer({ width, height, channels: 1, pixelData: pixels });
}

module.exports = {
	encodeRgba,
	encodeGrayscale,
	MAX_DIMENSION,
	MAX_PIXELS,
};
