/**
 * Brand palette system (shot-dsl 0.5.0): tonal backgrounds from the app's brand colours and ONE
 * set-wide text colour that passes WCAG AA (≥ 4.5:1) on every style-derived background.
 *
 * - `tonal` (new): `colors: [base, accent?]`, `tone: light | vivid | deep`. Each screen gets a
 *   light↔deep step of the base hue as a subtle vertical gradient (`light`: pale tints; `vivid`:
 *   around the brand colour; `deep`: richer, darker, warmer steps — still a colour, not a
 *   near-black); the text colour is a deep (or pale) tint of the same hue, never a grey.
 * - `family` / `sequence` (0.4.0): unchanged colours, but now also ONE text colour per set.
 *
 * Contrast is enforced by generation: `harmonize` evaluates both text candidates (dark / light),
 * picks the one that needs the smaller tone adjustment, and moves every style-derived background
 * stop away from the text colour (lighter under dark text, deeper under light text) in small
 * steps until the WORST sampled point of every background passes.
 */
import type { BackgroundJSON, ColorStop } from './types';
import { contrastRatio, isHexColor, mixHex, parseHex, toHex, DARK_TEXT, LIGHT_TEXT } from './color';

export const MIN_CONTRAST = 4.5;
/** Generation aims a little above AA so rounding never lands a sample at 4.49. */
const TARGET_CONTRAST = 4.6;

export type PaletteTone = 'light' | 'vivid' | 'deep';

export interface HSL {
	h: number;
	s: number;
	l: number;
}

export function hexToHsl(hex: string): HSL {
	const c = parseHex(hex) ?? { r: 31, g: 41, b: 55 };
	const r = c.r / 255;
	const g = c.g / 255;
	const b = c.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return { h: h * 60, s, l };
}

export function hslToHex({ h, s, l }: HSL): string {
	const hh = (((h % 360) + 360) % 360) / 360;
	const ss = Math.min(1, Math.max(0, s));
	const ll = Math.min(1, Math.max(0, l));
	if (ss === 0) return toHex({ r: ll * 255, g: ll * 255, b: ll * 255 });
	const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
	const p = 2 * ll - q;
	const hue = (t: number) => {
		let x = t;
		if (x < 0) x += 1;
		if (x > 1) x -= 1;
		if (x < 1 / 6) return p + (q - p) * 6 * x;
		if (x < 1 / 2) return q;
		if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
		return p;
	};
	return toHex({ r: hue(hh + 1 / 3) * 255, g: hue(hh) * 255, b: hue(hh - 1 / 3) * 255 });
}

/** Lightness steps (and per-step hue drift) of each tone; screen i uses step i % 4, the hero step 0. */
const TONE_STEPS: Record<PaletteTone, { l: number[]; sat: number; spread: number }> = {
	light: { l: [0.9, 0.93, 0.87, 0.95], sat: 0.85, spread: 0.035 },
	vivid: { l: [0, 0.09, -0.06, 0.15], sat: 1, spread: 0.07 },
	// Deep = richer, darker and warmer than the brand colour, still a colour (not a near-black).
	deep: { l: [0.46, 0.52, 0.42, 0.49], sat: 1, spread: 0.08 }
};
const HUE_DRIFT: Record<PaletteTone, number[]> = { light: [0, -5, 4, -8], vivid: [0, -5, 4, -8], deep: [-8, -3, -12, -6] };

/**
 * The tonal background of step `step` for `base` (before any contrast shift): a vertical gradient
 * (editor angle 180°: offset 0 = BOTTOM) from a slightly deeper tone at the bottom to a lighter
 * one at the top.
 */
export function tonalBackground(base: string, tone: PaletteTone, step: number): BackgroundJSON {
	const hsl = hexToHsl(base);
	const spec = TONE_STEPS[tone];
	const k = ((step % 4) + 4) % 4;
	const l = tone === 'vivid' ? Math.min(0.72, Math.max(0.34, hsl.l + spec.l[k])) : spec.l[k];
	const s = Math.min(1, hsl.s * spec.sat);
	const h = hsl.h + HUE_DRIFT[tone][k];
	const stops: ColorStop[] = [
		{ offset: 0, color: hslToHex({ h: h + 3, s, l: l - spec.spread }) },
		{ offset: 1, color: hslToHex({ h: h - 3, s: s * 0.96, l: l + spec.spread }) }
	];
	return { type: 'gradient', gradient: { type: 'linear', colorStops: stops, angle: 180 } };
}

/** Text candidates for a palette: a deep tint of the base hue and a pale one (tonal), else neutral. */
export function textCandidates(base: string | null): { dark: string; light: string } {
	if (!base) return { dark: DARK_TEXT, light: LIGHT_TEXT };
	const { h, s } = hexToHsl(base);
	return {
		dark: hslToHex({ h, s: Math.min(0.75, s * 0.8 + 0.1), l: 0.11 }),
		light: hslToHex({ h, s: Math.min(1, s), l: 0.975 })
	};
}

/** Move a background's stops `t` (0–1) of the way toward `target` (white or black). */
export function shiftBackground(bg: BackgroundJSON, target: string, t: number): BackgroundJSON {
	if (t <= 0) return bg;
	if (bg.type !== 'gradient' || !bg.gradient) {
		return { ...bg, color: isHexColor(bg.color) ? mixHex(bg.color, target, t) : bg.color };
	}
	const move = (c: string) => (isHexColor(c) ? mixHex(c, target, t) : c);
	return {
		...bg,
		gradient: {
			...bg.gradient,
			colorStops: (bg.gradient.colorStops ?? []).map((s) => ({ ...s, color: move(s.color) })),
			...(bg.gradient.colors ? { colors: bg.gradient.colors.map(move) } : {})
		}
	};
}

/** Worst WCAG contrast of `text` over sampled colours. */
export function worstContrast(text: string, samples: string[]): number {
	return samples.length ? Math.min(...samples.map((c) => contrastRatio(text, c))) : 21;
}

export interface Harmonized {
	text: string;
	/** Fraction the style-derived backgrounds were moved away from the text colour (0 = untouched). */
	shift: number;
	/** Worst contrast over every shiftable sample after the shift. */
	worst: number;
	/** Worst contrast over the FIXED samples (explicit backgrounds, never recoloured); 21 when none. */
	worstFixed: number;
}

/**
 * Choose the set's text colour and the tone shift that makes it pass everywhere.
 * - `samplesAt(target, shift)`: every sampled colour of the style-derived backgrounds (palette
 *   screens, panorama spans), moved toward `target` by `shift`.
 * - `fixed`: sampled colours of explicit backgrounds — they count toward the choice but are never
 *   recoloured.
 * Preference: the candidate that reaches AA on the shiftable samples with the least re-toning; the
 * other one instead only if IT also passes on the fixed samples and costs ≤ 0.15 more shift. Failing
 * explicit screens then get their own colour from the caller. `preferLight` breaks exact ties (the
 * 0.4.0 white default for explicit-only sets).
 */
export function harmonize(
	candidates: { dark: string; light: string },
	samplesAt: (target: string, shift: number) => string[],
	fixed: string[] = [],
	preferLight = false
): Harmonized {
	const solve = (text: string, target: string): Harmonized => {
		let shift = 0;
		let worst = worstContrast(text, samplesAt(target, 0));
		for (let i = 0; i < 40 && worst < TARGET_CONTRAST; i++) {
			shift = Math.min(1, shift + 0.025);
			worst = worstContrast(text, samplesAt(target, shift));
			if (shift >= 1) break;
		}
		return { text, shift, worst, worstFixed: worstContrast(text, fixed) };
	};
	const dark = solve(candidates.dark, '#FFFFFF');
	const light = solve(candidates.light, '#000000');
	const passes = (h: Harmonized) => h.worst >= MIN_CONTRAST;
	const passesAll = (h: Harmonized) => passes(h) && h.worstFixed >= MIN_CONTRAST;
	const pick = (a: Harmonized, b: Harmonized) => {
		if (a.shift !== b.shift) return a.shift < b.shift ? a : b;
		if (preferLight) return b;
		return Math.min(a.worst, a.worstFixed) >= Math.min(b.worst, b.worstFixed) ? a : b;
	};
	// Primary: the candidate that makes the palette pass with the least re-toning.
	const primary = passes(dark) && passes(light) ? pick(dark, light) : passes(dark) ? dark : passes(light) ? light : dark.worst >= light.worst ? dark : light;
	if (passesAll(primary)) return primary;
	// The other candidate may also pass on the explicit backgrounds — worth it only if that costs
	// little extra re-toning (a light palette is never turned dark to suit one dark screen; that
	// screen gets its own colour instead).
	const other = primary === dark ? light : dark;
	if (passesAll(other) && other.shift <= primary.shift + MAX_EXTRA_SHIFT_FOR_FIXED) return other;
	return primary;
}

/** How much more palette re-toning is acceptable to get ONE colour that also passes on explicit backgrounds. */
const MAX_EXTRA_SHIFT_FOR_FIXED = 0.15;
