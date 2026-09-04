/**
 * Windows BMP encoders for monochrome e-ink panels.
 *
 * Two containers live here:
 *  - `encodeBmp1bit`  — 1-bit black & white (2 colours).
 *  - `encodeGrayBmp`  — 4bpp with an N-entry grayscale palette, used for every panel that shows
 *                       more than black & white: 4-gray (2-bit) and 8-gray (3-bit) monochrome
 *                       e-ink, and the 16-gray (4-bit) TRMNL X.
 *
 * --- 1-bit ---
 *
 * TRMNL "OG" devices on the older / DIY firmware line (e.g. the Seeed Studio
 * TRMNL 7.5 OG DIY Kit, firmware 1.6.x / 1.8.x) expect a 1-bit BMP image rather
 * than the 8-bit grayscale PNG that Inker serves for firmware 1.7.8. Sharp cannot
 * write BMP, so we encode it by hand here. See issue #31.
 *
 * The input is single-channel (1 byte/pixel) grayscale data — typically the
 * Floyd-Steinberg dithered output where each pixel is already 0 (black) or 255
 * (white). Any value >= `threshold` (default 128) is treated as white.
 *
 * Output is a standard uncompressed (BI_RGB) bottom-up BMP with a 2-colour
 * palette (index 0 = black, index 1 = white). White pixels map to bit 1.
 */

const FILE_HEADER_SIZE = 14;
const INFO_HEADER_SIZE = 40;
const PALETTE_SIZE = 8; // 2 entries * 4 bytes (BGRA)
const PIXEL_DATA_OFFSET = FILE_HEADER_SIZE + INFO_HEADER_SIZE + PALETTE_SIZE; // 62

export interface EncodeBmp1bitOptions {
  /** Grayscale value at/above which a pixel is considered white (bit 1). Default 128. */
  threshold?: number;
  /** Invert bit/colour mapping (white pixel -> bit 0). Default false. */
  invert?: boolean;
}

/**
 * Encode single-channel grayscale pixel data as a 1-bit BMP.
 *
 * @param gray   - width*height bytes, one grayscale value per pixel, row-major, top-to-bottom
 * @param width  - image width in pixels
 * @param height - image height in pixels
 * @returns a Buffer containing a complete .bmp file
 */
export function encodeBmp1bit(
  gray: Buffer | Uint8Array,
  width: number,
  height: number,
  options: EncodeBmp1bitOptions = {},
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid BMP dimensions: ${width}x${height}`);
  }
  if (gray.length < width * height) {
    throw new Error(
      `Pixel buffer too small for ${width}x${height}: got ${gray.length}, need ${width * height}`,
    );
  }

  const threshold = options.threshold ?? 128;
  const whiteBit = options.invert ? 0 : 1;

  // Each row is packed to a 4-byte boundary (BMP requirement).
  const rowBytes = Math.ceil(width / 8);
  const rowStride = (rowBytes + 3) & ~3; // round up to multiple of 4
  const pixelDataSize = rowStride * height;
  const fileSize = PIXEL_DATA_OFFSET + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // --- BITMAPFILEHEADER (14 bytes) ---
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6); // reserved
  buf.writeUInt32LE(PIXEL_DATA_OFFSET, 10);

  // --- BITMAPINFOHEADER (40 bytes) ---
  buf.writeUInt32LE(INFO_HEADER_SIZE, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive => bottom-up rows
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(1, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // compression = BI_RGB
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38); // ~72 DPI horizontal (pixels/metre)
  buf.writeInt32LE(2835, 42); // ~72 DPI vertical
  buf.writeUInt32LE(2, 46); // colours used
  buf.writeUInt32LE(2, 50); // important colours

  // --- Palette (BGRA): index 0 = black, index 1 = white ---
  // index 0
  buf.writeUInt8(0x00, 54);
  buf.writeUInt8(0x00, 55);
  buf.writeUInt8(0x00, 56);
  buf.writeUInt8(0x00, 57);
  // index 1
  buf.writeUInt8(0xff, 58);
  buf.writeUInt8(0xff, 59);
  buf.writeUInt8(0xff, 60);
  buf.writeUInt8(0x00, 61);

  // --- Pixel data (bottom-up, MSB = leftmost pixel) ---
  for (let y = 0; y < height; y++) {
    // BMP stores the bottom row first.
    const rowStart = PIXEL_DATA_OFFSET + (height - 1 - y) * rowStride;
    const srcRow = y * width;
    for (let x = 0; x < width; x++) {
      const isWhite = gray[srcRow + x] >= threshold;
      const bit = isWhite ? whiteBit : whiteBit ^ 1;
      if (bit) {
        const byteIndex = rowStart + (x >> 3);
        buf[byteIndex] |= 0x80 >> (x & 7);
      }
    }
  }

  return buf;
}

// --- Multi-level grayscale BMP (4bpp container) ---
//
// Grayscale e-ink panels come in a few depths: 4 grays (2-bit — the common "monochrome with
// grayscale" panels), 8 grays (3-bit) and 16 grays (4-bit — TRMNL X). BMP has no standard 2bpp or
// 3bpp form (biBitCount is 1/4/8/16/24/32; 2 exists only as a Windows CE extension most decoders
// reject), so all of them are carried in a 4bpp BMP whose palette holds exactly `levels`
// evenly-spaced grays. Because the palette is sized to the panel, a pixel's stored index IS its
// gray level (0 = black … levels-1 = white), which is what a 2-/3-/4-bit panel driver wants.

const GRAY_INFO_OFFSET = FILE_HEADER_SIZE + INFO_HEADER_SIZE; // 54, start of the palette
const MAX_GRAY_LEVELS = 16; // 4bpp ceiling — one nibble per pixel

/** Levels of an 8-bit grayscale source — the most any of our output paths can carry. */
export const FULL_GRAY_LEVELS = 256;

/**
 * Gray levels a panel of the given bit depth can show: 1-bit → 2, 2-bit → 4, 3-bit → 8,
 * 4-bit → 16, 8-bit → 256 (full grayscale, e.g. the Kindle models TRMNL lists).
 */
export function grayLevelsForBitDepth(bitDepth: number): number {
  if (bitDepth <= 1) return 2;
  return Math.min(FULL_GRAY_LEVELS, 1 << bitDepth);
}

/**
 * Gray levels a BMP of ours can actually carry — the 4bpp container tops out at 16, so a deeper
 * panel asking for BMP is served 16 grays rather than nothing.
 */
export function bmpGrayLevels(levels: number): number {
  return Math.min(levels, MAX_GRAY_LEVELS);
}

/** Map an 8-bit grayscale value (0-255) to a level index (0 … levels-1). */
export function grayToLevel(v: number, levels: number): number {
  const max = levels - 1;
  return Math.max(0, Math.min(max, Math.round((v / 255) * max)));
}

/** Map a level index back to its 8-bit grayscale value (level 0 → 0, level levels-1 → 255). */
export function levelToGray8(level: number, levels: number): number {
  return Math.round((level * 255) / (levels - 1));
}

/** Map an 8-bit grayscale value (0-255) to a 4-bit level (0-15). */
export function gray8ToLevel4(v: number): number {
  return grayToLevel(v, MAX_GRAY_LEVELS);
}

/**
 * Posterize an 8-bit grayscale buffer to `levels` evenly-spaced grays (4 levels → 0x00, 0x55,
 * 0xAA, 0xFF; 16 levels → 0x00, 0x11, … 0xFF). Returns a new 8-bit buffer — used for grayscale PNG
 * output where the container stays 8-bit but the content is limited to the panel's grays (which
 * also compresses well). For anything but flat graphics, dither first (see `floydSteinbergDither`)
 * — posterizing alone bands badly at low level counts.
 */
export function quantizeGrayLevels(gray: Buffer | Uint8Array, levels: number): Buffer {
  const out = Buffer.alloc(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = levelToGray8(grayToLevel(gray[i], levels), levels);
  }
  return out;
}

/** Posterize to the 16 levels of a 4-bit panel (TRMNL X). */
export function quantizeGray16(gray: Buffer | Uint8Array): Buffer {
  return quantizeGrayLevels(gray, MAX_GRAY_LEVELS);
}

/**
 * Encode single-channel grayscale pixel data as a 4bpp BMP with a `levels`-entry grayscale palette.
 *
 * Sending a grayscale panel a matching multi-level image (rather than the 1-bit dithered output
 * used for pure black & white panels) preserves gradients. Sharp cannot write sub-8-bit grayscale,
 * so it is hand-encoded here, mirroring `encodeBmp1bit`.
 *
 * Each input pixel is quantized to one of `levels` evenly-spaced gray levels and stored as that
 * level's palette index. Output is an uncompressed (BI_RGB) bottom-up BMP; two pixels are packed
 * per byte (high nibble = leftmost pixel).
 *
 * @param gray   - width*height bytes, one grayscale value per pixel, row-major, top-to-bottom
 * @param width  - image width in pixels
 * @param height - image height in pixels
 * @param levels - gray levels / palette entries (2-16, e.g. 4 for a 2-bit panel)
 */
export function encodeGrayBmp(
  gray: Buffer | Uint8Array,
  width: number,
  height: number,
  levels: number = MAX_GRAY_LEVELS,
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid BMP dimensions: ${width}x${height}`);
  }
  if (gray.length < width * height) {
    throw new Error(
      `Pixel buffer too small for ${width}x${height}: got ${gray.length}, need ${width * height}`,
    );
  }
  if (!Number.isInteger(levels) || levels < 2 || levels > MAX_GRAY_LEVELS) {
    throw new Error(
      `Invalid gray level count for a 4bpp BMP: ${levels} (expected 2-${MAX_GRAY_LEVELS})`,
    );
  }

  const pixelOffset = GRAY_INFO_OFFSET + levels * 4;

  // 4bpp: ceil(width/2) bytes/row, padded to a 4-byte boundary.
  const rowBytes = Math.ceil(width / 2);
  const rowStride = (rowBytes + 3) & ~3;
  const pixelDataSize = rowStride * height;
  const fileSize = pixelOffset + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // --- BITMAPFILEHEADER ---
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(pixelOffset, 10);

  // --- BITMAPINFOHEADER ---
  buf.writeUInt32LE(INFO_HEADER_SIZE, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive => bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(4, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(levels, 46); // colours used
  buf.writeUInt32LE(levels, 50); // important colours

  // --- Palette: `levels` evenly-spaced grays (BGRA) ---
  for (let i = 0; i < levels; i++) {
    const v = levelToGray8(i, levels);
    const off = GRAY_INFO_OFFSET + i * 4;
    buf.writeUInt8(v, off);      // B
    buf.writeUInt8(v, off + 1);  // G
    buf.writeUInt8(v, off + 2);  // R
    buf.writeUInt8(0, off + 3);  // reserved
  }

  // --- Pixel data (bottom-up, high nibble = leftmost pixel) ---
  for (let y = 0; y < height; y++) {
    const rowStart = pixelOffset + (height - 1 - y) * rowStride;
    const srcRow = y * width;
    for (let x = 0; x < width; x++) {
      const level = grayToLevel(gray[srcRow + x], levels);
      const byteIndex = rowStart + (x >> 1);
      if ((x & 1) === 0) {
        buf[byteIndex] |= level << 4; // high nibble
      } else {
        buf[byteIndex] |= level; // low nibble
      }
    }
  }

  return buf;
}

/** Encode as a 4-bit, 16-level grayscale BMP (TRMNL X). */
export function encodeGray4Bmp(
  gray: Buffer | Uint8Array,
  width: number,
  height: number,
): Buffer {
  return encodeGrayBmp(gray, width, height, MAX_GRAY_LEVELS);
}

/**
 * Encode a BMP for a panel of `levels` grays: a 1-bit BMP for black & white, a 4bpp grayscale BMP
 * otherwise. Deeper panels are capped to the 4bpp container's 16 grays.
 */
export function encodeBmpForLevels(
  gray: Buffer | Uint8Array,
  width: number,
  height: number,
  levels: number,
): Buffer {
  return levels <= 2
    ? encodeBmp1bit(gray, width, height)
    : encodeGrayBmp(gray, width, height, bmpGrayLevels(levels));
}
