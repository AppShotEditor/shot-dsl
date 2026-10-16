/**
 * Tiny, dependency-free colour helpers for the composer's palette / panorama / badge styling.
 * Only `#rgb` / `#rrggbb` hex input is understood; anything else is passed through untouched
 * (callers fall back to sensible defaults).
 */

export type RGB = { r: number; g: number; b: number };

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: unknown): value is string {
	return typeof value === 'string' && HEX.test(value);
}

export function parseHex(hex: string): RGB | null {
	if (!isHexColor(hex)) return null;
	let h = hex.slice(1);
	if (h.length === 3) h = h.replace(/./g, (c) => c + c);
	return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function toHex({ r, g, b }: RGB): string {
	const c = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** Linear mix of `a` toward `b` by `t` (0 → a, 1 → b). Non-hex input returns `a`. */
export function mixHex(a: string, b: string, t: number): string {
	const x = parseHex(a);
	const y = parseHex(b);
	if (!x || !y) return a;
	return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

export const lighten = (hex: string, t: number): string => mixHex(hex, '#ffffff', t);
export const darken = (hex: string, t: number): string => mixHex(hex, '#000000', t);

/** WCAG relative luminance (0 = black, 1 = white); 0 for non-hex input. */
export function luminance(hex: string): number {
	const c = parseHex(hex);
	if (!c) return 0;
	const lin = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** `rgba(r,g,b,a)` from a hex colour (white for non-hex input). */
export function rgba(hex: string, alpha: number): string {
	const c = parseHex(hex) ?? { r: 255, g: 255, b: 255 };
	return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

/** WCAG contrast ratio between two hex colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

export const DARK_TEXT = '#111827';
export const LIGHT_TEXT = '#FFFFFF';

/**
 * The text colour (white or near-black) with the best WORST-case contrast against every sampled
 * background colour (e.g. several points of a gradient behind a headline).
 */
export function readableTextOn(backgrounds: string[]): string {
	const worst = (text: string) => Math.min(...backgrounds.map((bg) => contrastRatio(text, bg)));
	return worst(DARK_TEXT) > worst(LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}

/** Readable text colour on a background of `hex` (see readableTextOn). */
export function contrastText(hex: string): string {
	return readableTextOn([hex]);
}
