import { describe, it, expect } from 'bun:test';
import { escapeXml, panelPixelsToPng, svgToPanelPixels } from './panel-image.util';

/** A simple black-on-white SVG, the shape every generated screen takes. */
function testSvg(width = 40, height = 20): string {
  return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <rect x="0" y="0" width="${width / 2}" height="${height}" fill="#808080"/>
      <text x="2" y="12" font-family="sans-serif" font-size="10" fill="black">Hi</text>
    </svg>
  `.trim();
}

describe('panel-image.util', () => {
  describe('escapeXml', () => {
    it('escapes the characters that would break a generated SVG', () => {
      expect(escapeXml(`<b>"A" & 'B'</b>`)).toBe(
        '&lt;b&gt;&quot;A&quot; &amp; &apos;B&apos;&lt;/b&gt;',
      );
    });

    it('leaves ordinary text alone', () => {
      expect(escapeXml('Sleeping until 07:00')).toBe('Sleeping until 07:00');
    });
  });

  describe('svgToPanelPixels', () => {
    it('renders at the SVG dimensions, one byte per pixel', async () => {
      const panel = await svgToPanelPixels(testSvg(40, 20), 2);
      expect(panel.width).toBe(40);
      expect(panel.height).toBe(20);
      expect(panel.pixels.length).toBe(40 * 20);
    });

    it('reduces to pure black and white for a 1-bit panel', async () => {
      const panel = await svgToPanelPixels(testSvg(), 2);
      expect([...new Set(panel.pixels)].sort((a, b) => a - b)).toEqual([0, 255]);
    });

    it('keeps the mid-gray block as a real gray on a 4-gray panel', async () => {
      const panel = await svgToPanelPixels(testSvg(), 4);
      const used = new Set(panel.pixels);
      // every value must be one of the panel's four levels…
      expect([...used].every((v) => [0, 85, 170, 255].includes(v))).toBe(true);
      // …and the 50% block must survive as something other than black or white
      expect([...used].some((v) => v === 85 || v === 170)).toBe(true);
    });
  });

  describe('panelPixelsToPng', () => {
    it('wraps reduced pixels in a single-channel grayscale PNG', async () => {
      const panel = await svgToPanelPixels(testSvg(), 2);
      const png = await panelPixelsToPng(panel);

      // PNG magic number
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // IHDR: width/height big-endian at byte 16, then bit depth + colour type
      expect(png.readUInt32BE(16)).toBe(panel.width);
      expect(png.readUInt32BE(20)).toBe(panel.height);
      expect(png[25]).toBe(0); // colour type 0 = grayscale, not palette
    });
  });
});
