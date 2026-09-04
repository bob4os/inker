import * as sharpModule from 'sharp';
// Handle both ESM and CJS imports for Bun compatibility
const sharp = (sharpModule as any).default || sharpModule;
import { reduceToGrayLevels } from './dither.util';

/**
 * Turning a generated SVG into an image a panel can show.
 *
 * The server generates a handful of screens itself rather than through the designer — the welcome
 * / default screen, the sleep screen, the setup screen — and they all went through the same four
 * steps by hand: render the SVG, flatten it to grayscale, reduce it to the panel's gray levels,
 * then write a PNG and/or a BMP. That pipeline lives here once so a change to how a panel's grays
 * are produced can't drift between them.
 */

/** Escape XML special characters so user-provided text can't corrupt a generated SVG. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface PanelPixels {
  /** One byte per pixel, already snapped to the panel's gray levels. */
  pixels: Buffer;
  width: number;
  height: number;
}

/**
 * Render an SVG and reduce it to what a panel of `levels` grays can show — dithered at 2-8 levels,
 * posterized at 16, untouched at full grayscale (see `reduceToGrayLevels`).
 *
 * @param svg    - complete SVG document
 * @param levels - gray levels of the target panel (see `grayLevelsForBitDepth`)
 */
export async function svgToPanelPixels(
  svg: string,
  levels: number,
  options: { threshold?: number } = {},
): Promise<PanelPixels> {
  const { data, info } = await sharp(Buffer.from(svg))
    .grayscale()
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    pixels: reduceToGrayLevels(data, info.width, info.height, levels, {
      threshold: options.threshold ?? 140,
    }),
    width: info.width,
    height: info.height,
  };
}

/**
 * Wrap already-reduced pixels in a standard 8-bit grayscale PNG (color_type=0). The container
 * stays 8-bit while the content is limited to the panel's grays — firmware handles the display
 * colour mapping, and palette PNGs scramble some devices.
 */
export async function panelPixelsToPng({ pixels, width, height }: PanelPixels): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .toColorspace('b-w')
    .png({ compressionLevel: 9 })
    .toBuffer();
}
