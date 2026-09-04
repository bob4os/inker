/**
 * Panel depth helpers, shared by the model editor and the device page.
 *
 * A model's bit depth drives the whole image pipeline on the server: how many gray levels a screen
 * is dithered down to, and which container the device is sent (1-bit BMP, 4bpp grayscale BMP, or a
 * grayscale PNG). Keep this list in step with the backend's `grayLevelsForBitDepth`.
 */
export interface PanelDepth {
  value: number;
  label: string;
  colors: number;
  hint: string;
}

export const PANEL_DEPTHS: PanelDepth[] = [
  {
    value: 1,
    label: 'Black & white (1-bit)',
    colors: 2,
    hint: 'Classic e-ink. Images are dithered to pure black and white.',
  },
  {
    value: 2,
    label: '4 grays (2-bit)',
    colors: 4,
    hint: 'Monochrome panels with grayscale support — black, dark gray, light gray, white. Images are dithered to those four levels.',
  },
  {
    value: 3,
    label: '8 grays (3-bit)',
    colors: 8,
    hint: 'Deeper grayscale panels. Images are dithered to eight levels.',
  },
  {
    value: 4,
    label: '16 grays (4-bit)',
    colors: 16,
    hint: 'TRMNL X and other 16-level panels. Posterized, not dithered — the steps are close enough together already.',
  },
  {
    value: 8,
    label: 'Full grayscale (8-bit)',
    colors: 256,
    hint: 'Kindle-class panels. Sent as a plain 8-bit grayscale PNG. BMP output caps at 16 grays.',
  },
];

/** The depth entry for a model's bitDepth, falling back to black & white. */
export function panelDepthFor(bitDepth?: number): PanelDepth {
  return PANEL_DEPTHS.find((d) => d.value === (bitDepth ?? 1)) ?? PANEL_DEPTHS[0];
}

/** Short badge for a model's depth, e.g. "1-bit" or "4 grays". */
export function depthLabel(bitDepth?: number): string {
  const depth = panelDepthFor(bitDepth);
  return depth.value === 1 ? '1-bit' : `${depth.colors} grays`;
}
