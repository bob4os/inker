import { describe, it, expect } from 'bun:test';
import { floydSteinbergDither, reduceToGrayLevels } from './dither.util';
import { quantizeGrayLevels } from './bmp1bit.util';

/** A horizontal 0-255 gradient, 4 rows tall — the case that bands worst without dithering. */
function gradient(width = 256, height = 4): Buffer {
  return Buffer.from(
    Array.from({ length: width * height }, (_, i) => Math.floor((i % width) * (255 / (width - 1)))),
  );
}

/** Mean brightness — error diffusion should preserve it even as it quantizes. */
function mean(buf: Buffer | Uint8Array): number {
  return [...buf].reduce((a, v) => a + v, 0) / buf.length;
}

/** Count of adjacent pixels that differ — a proxy for "dithered" vs "banded". */
function transitions(buf: Buffer | Uint8Array): number {
  let n = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i] !== buf[i - 1]) n++;
  return n;
}

describe('dither.util', () => {
  describe('floydSteinbergDither', () => {
    it('emits only black and white at 2 levels', () => {
      const out = floydSteinbergDither(gradient(), 256, 4, { levels: 2 });
      expect([...new Set(out)].sort((a, b) => a - b)).toEqual([0, 255]);
    });

    it('emits exactly the 4 panel grays at 4 levels', () => {
      const out = floydSteinbergDither(gradient(), 256, 4, { levels: 4 });
      expect([...new Set(out)].sort((a, b) => a - b)).toEqual([0, 85, 170, 255]);
    });

    it('emits 8 grays at 8 levels', () => {
      const out = floydSteinbergDither(gradient(), 256, 4, { levels: 8 });
      expect(new Set(out).size).toBe(8);
    });

    it('preserves overall brightness while quantizing', () => {
      const src = gradient();
      const out = floydSteinbergDither(src, 256, 4, { levels: 4 });
      expect(Math.abs(mean(out) - mean(src))).toBeLessThan(3);
    });

    it('breaks up the banding that plain posterizing leaves', () => {
      const src = gradient();
      const dithered = floydSteinbergDither(src, 256, 4, { levels: 4 });
      const posterized = quantizeGrayLevels(src, 4);
      expect(transitions(dithered)).toBeGreaterThan(transitions(posterized) * 5);
    });

    it('honours the 1-bit threshold (higher favours white)', () => {
      // A flat mid-gray field: below the threshold it goes black, above it goes white.
      const flat = Buffer.alloc(64, 130);
      const white = floydSteinbergDither(flat, 8, 8, { levels: 2, threshold: 120 });
      const black = floydSteinbergDither(flat, 8, 8, { levels: 2, threshold: 200 });
      expect(white[0]).toBe(255);
      expect(black[0]).toBe(0);
    });

    it('keeps the contrast boost for 1-bit only', () => {
      // 210 is "near-white": snapped to pure white at 2 levels, but a real level at 4.
      const nearWhite = Buffer.alloc(4, 210);
      expect(floydSteinbergDither(nearWhite, 2, 2, { levels: 2 })[0]).toBe(255);
      expect(floydSteinbergDither(nearWhite, 2, 2, { levels: 4 })[0]).toBe(170);
    });

    it('throws when the buffer is too small for the dimensions', () => {
      expect(() => floydSteinbergDither(Buffer.alloc(3), 2, 2)).toThrow();
    });
  });

  describe('reduceToGrayLevels', () => {
    it('dithers at 4 levels', () => {
      const out = reduceToGrayLevels(gradient(), 256, 4, 4);
      expect([...new Set(out)].sort((a, b) => a - b)).toEqual([0, 85, 170, 255]);
    });

    it('posterizes rather than dithers at 16 levels (TRMNL X)', () => {
      const src = gradient();
      expect(Buffer.compare(reduceToGrayLevels(src, 256, 4, 16), quantizeGrayLevels(src, 16))).toBe(0);
    });

    it('leaves full 8-bit grayscale untouched', () => {
      const src = gradient();
      expect(Buffer.compare(reduceToGrayLevels(src, 256, 4, 256), Buffer.from(src))).toBe(0);
    });
  });
});
