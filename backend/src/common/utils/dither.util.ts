import {
  FULL_GRAY_LEVELS,
  grayToLevel,
  levelToGray8,
  quantizeGrayLevels,
} from './bmp1bit.util';

/**
 * Floyd-Steinberg error-diffusion dithering for e-ink output.
 *
 * Shared by every render path (designed screens, default screen, sleep screen, uploaded images) so
 * a panel gets the same treatment wherever its picture comes from.
 *
 * The classic 1-bit case snaps each pixel to black or white; the multi-level case snaps it to the
 * nearest of `levels` evenly-spaced grays instead. In both cases the quantization error is pushed
 * into the not-yet-processed neighbours:
 *
 *         X   7/16
 *  3/16 5/16 1/16
 *
 * Dithering matters most at LOW level counts: a 4-gray (2-bit) panel posterized without error
 * diffusion shows hard banding across every gradient and shadow, while diffusing the error trades
 * that banding for fine noise the eye reads as intermediate tones.
 */

export interface DitherOptions {
  /**
   * Number of output gray levels. 2 = pure black & white (1-bit panels), 4 = 2-bit grayscale
   * panels, 8 = 3-bit, 16 = 4-bit (TRMNL X). Default 2.
   */
  levels?: number;
  /**
   * 1-bit only: grayscale value at/above which a pixel becomes white. The default of 140 (rather
   * than 128) favours white, which reads better on e-ink. Ignored when `levels > 2`, where the
   * nearest of the evenly-spaced levels always wins.
   */
  threshold?: number;
  /**
   * Snap near-black/near-white pixels to pure black/white before diffusing, for crisper text.
   * Defaults to true at 2 levels and false above — with more levels available the "near" bands are
   * real output values, so clamping them away only throws away tones the panel could have shown.
   */
  contrastBoost?: boolean;
}

/**
 * Dither single-channel 8-bit grayscale pixels down to `levels` gray levels.
 *
 * @param data   - width*height bytes, one grayscale value per pixel, row-major, top-to-bottom
 * @param width  - image width in pixels
 * @param height - image height in pixels
 * @returns a new 8-bit buffer whose values are snapped to the level grays (2 levels → 0/255,
 *          4 levels → 0x00/0x55/0xAA/0xFF, …), ready for `encodeBmp1bit`, `encodeGrayBmp` or an
 *          8-bit grayscale PNG.
 */
export function floydSteinbergDither(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  options: DitherOptions = {},
): Buffer {
  const levels = options.levels ?? 2;
  const threshold = options.threshold ?? 140;
  const contrastBoost = options.contrastBoost ?? levels === 2;
  const count = width * height;

  if (data.length < count) {
    throw new Error(
      `Pixel buffer too small for ${width}x${height}: got ${data.length}, need ${count}`,
    );
  }

  const pixels = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const val = data[i];
    if (contrastBoost && val > 200) pixels[i] = 255;      // near-white becomes pure white
    else if (contrastBoost && val < 55) pixels[i] = 0;    // near-black becomes pure black
    else pixels[i] = val;
  }

  // Snap to the nearest available level. At 2 levels the threshold decides, so a screen full of
  // light-gray anti-aliasing still comes out white rather than half-dithered.
  const quantize = (v: number): number =>
    levels === 2 ? (v < threshold ? 0 : 255) : levelToGray8(grayToLevel(v, levels), levels);

  const diffuse = (index: number, error: number, weight: number) => {
    // Clamp after each addition — unbounded error accumulation produces smearing artifacts along
    // large flat areas.
    pixels[index] = Math.max(0, Math.min(255, pixels[index] + (error * weight) / 16));
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = pixels[idx];
      const newPixel = quantize(oldPixel);
      pixels[idx] = newPixel;
      const error = oldPixel - newPixel;

      if (x + 1 < width) diffuse(idx + 1, error, 7);
      if (y + 1 < height) {
        const below = (y + 1) * width + x;
        if (x - 1 >= 0) diffuse(below - 1, error, 3);
        diffuse(below, error, 5);
        if (x + 1 < width) diffuse(below + 1, error, 1);
      }
    }
  }

  const output = Buffer.alloc(count);
  for (let i = 0; i < count; i++) {
    output[i] = Math.max(0, Math.min(255, Math.round(pixels[i])));
  }

  return output;
}

/**
 * Reduce a grayscale buffer to what a panel of `levels` grays can actually show — the one place
 * that decides how each depth is treated, shared by every render path:
 *
 *  - 2-8 levels: Floyd-Steinberg error diffusion. Too few levels to posterize; without diffusion
 *    a 4-gray panel bands across every gradient.
 *  - 16 levels: posterize. The steps are close enough together that dithering buys nothing and
 *    only adds noise (this is the TRMNL X path).
 *  - 256 levels: untouched — the source is already 8-bit grayscale.
 *
 * @param data   - width*height bytes of 8-bit grayscale, row-major, top-to-bottom
 * @param levels - see `grayLevelsForBitDepth`
 */
export function reduceToGrayLevels(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  levels: number,
  options: Pick<DitherOptions, 'threshold'> = {},
): Buffer {
  if (levels >= FULL_GRAY_LEVELS) return Buffer.from(data);
  if (levels >= 16) return quantizeGrayLevels(data, levels);
  return floydSteinbergDither(data, width, height, { levels, threshold: options.threshold });
}
