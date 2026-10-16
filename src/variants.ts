import {
	canvasDimsForDevice,
	type ComposeHero,
	type ComposeMascot,
	type ComposePalette,
	type ComposePlan,
	type ComposeScreenPlan,
	type ComposeStyle
} from './compose';
import { isHexColor } from './color';
import type { Motif } from './decor';

/**
 * Three DISTINCT art directions from one plan — Product Page Optimization test candidates, not tweaks
 * (shot-dsl 0.5.0):
 * - **A Brand Classic**: device frames on the vivid tonal brand palette; hero with the mascot + badge;
 *   callouts on the selling screens by default (explicit, else from a tight `focus`; the input can
 *   turn this off with `style.callouts: 'none'`); an accent rhythm (every 4th screen text-bottom); shadows.
 * - **B Clean Frameless**: pale tonal backgrounds with dark text; big full-width frameless
 *   screenshots bleeding deep off the bottom (a zoom card only where the plan marks an explicit
 *   `crop`); magnified callouts by default (explicit, else derived from a tight `focus`; same
 *   `style.callouts: 'none'` opt-out as A); hero with large type + the mascot.
 * - **C Story Panorama**: the deep tonal palette as ONE continuous scene across triples/pairs of
 *   screens with a flowing motif (`style.panorama.decoration`, default `wave`), the mascot
 *   travelling across the seams, a tilted hero that prefers a deeper bleed (but clears rather than
 *   leave a gap under the text).
 *
 * KEPT from the input (every concept): name (+ suffix), canvas size, copy (headline / subheadline /
 * badge), colours (headlineColor / subheadlineColor), `background`, `deviceId`, `screenshot`,
 * `focus`, `crop`, `callout`, per-screen `mascot`, `art`, the style's `font`, its `bleed` preference
 * (default `auto`; B and C use `deep` unless the input says `none`), and its `callouts` preference
 * (default `auto` for A and B if the input doesn't set one explicitly; C is always `none`).
 *
 * BRAND COLOURS: `style.palette.colors` (the first is the base, a tonal palette's second is the
 * accent); without a palette, the first screen's background colour. Concepts then use
 * `mode: "tonal"` with their own tone. Without any brand colour, the input palette/backgrounds stay.
 *
 * OVERRIDDEN (the concept decides these):
 * - every screen's `layout` → `text-top` (one shared system; the hero and rhythm accents differ);
 * - per-screen `presentation` / `tilt` are dropped;
 * - `hero`, `rhythm`, `tilt`/`tiltScreens` and `panorama` are set per concept (C keeps the input's
 *   `panorama.spans` / `decoration` when given);
 * - `callouts` is set per concept too, but only C's is fixed (`none`) regardless of the input — A and
 *   B fall back to `auto` only when the input leaves `callouts` unset (see `baseStyle`).
 */
export type VariantKey = 'A' | 'B' | 'C';

export interface ComposeVariant {
	key: VariantKey;
	label: string;
	plan: ComposePlan;
}

export const VARIANT_LABELS: Record<VariantKey, string> = { A: 'Brand Classic', B: 'Clean Frameless', C: 'Story Panorama' };

/** Tilt (degrees) the panorama concept gives its hero screen. */
export const VARIANT_HERO_TILT = 8;
/** Rhythm period of concept A (every 4th screen is an accent). */
export const VARIANT_RHYTHM_EVERY = 4;

const suffix = (name: string, key: VariantKey) => `${name} — ${key} ${VARIANT_LABELS[key]}`;

/** Copy a screen without the per-screen style knobs a concept decides (layout/presentation/tilt). */
function baseScreen(screen: ComposeScreenPlan): ComposeScreenPlan {
	const copy: ComposeScreenPlan = JSON.parse(JSON.stringify(screen));
	delete copy.layout;
	delete copy.presentation;
	delete copy.tilt;
	return { ...copy, layout: 'text-top' };
}

/** The plan's brand colours: [base, accent?] (see module doc), or null. */
export function brandColors(plan: ComposePlan): { base: string; accent?: string } | null {
	const pal = plan.style?.palette;
	const colors = (pal?.colors ?? []).filter(isHexColor);
	if (colors.length) return { base: colors[0], accent: pal?.mode === 'tonal' ? colors[1] : undefined };
	const bg = plan.screens[0]?.background;
	const first = bg?.type === 'gradient' ? (bg.gradient?.colorStops?.[0]?.color ?? bg.gradient?.colors?.[0]) : bg?.color;
	return isHexColor(first) ? { base: first } : null;
}

function tonal(plan: ComposePlan, tone: 'light' | 'vivid' | 'deep'): ComposePalette | undefined {
	const brand = brandColors(plan);
	if (!brand) return plan.style?.palette ? JSON.parse(JSON.stringify(plan.style.palette)) : undefined;
	return { mode: 'tonal', colors: brand.accent ? [brand.base, brand.accent] : [brand.base], tone };
}

/**
 * Style knobs every concept inherits from the input, defaulted the same way for all three: `bleed`
 * (default `auto`), `font` (kept only if set), and `callouts` (default `auto`) — concepts that want a
 * different `callouts` (currently only C, always `none`) set it explicitly afterwards, which wins.
 */
function baseStyle(plan: ComposePlan): ComposeStyle {
	const style = plan.style;
	const out: ComposeStyle = { bleed: style?.bleed ?? 'auto', callouts: style?.callouts ?? 'auto' };
	if (style?.font) out.font = style.font;
	return out;
}

/** The hero mascot: the input hero's, else the first art, anchored by the headline. */
function heroMascot(plan: ComposePlan, size?: number): ComposeMascot | undefined {
	const given = plan.style?.hero && typeof plan.style.hero === 'object' ? plan.style.hero.mascot : undefined;
	if (given) return { ...given };
	const art = plan.art?.[0];
	return art ? { art: art.id, anchor: 'headline', ...(size ? { size } : {}) } : undefined;
}

/** The input's hero screen index (-1 when the input turns the hero off). */
function heroIndexOf(plan: ComposePlan): number {
	const h = plan.style?.hero;
	if (h === false) return -1;
	const i = h && typeof h === 'object' && Number.isFinite(h.screen) ? Math.floor(h.screen!) : 0;
	return Math.min(Math.max(0, i), Math.max(0, plan.screens.length - 1));
}

/** The concept's hero: the input's (incl. `screen`) + the concept's overrides; `false` stays off. */
function hero(plan: ComposePlan, extra: ComposeHero, mascotSize?: number): ComposeHero | false {
	if (plan.style?.hero === false) return false;
	const input = plan.style?.hero && typeof plan.style.hero === 'object' ? plan.style.hero : {};
	const out: ComposeHero = { ...JSON.parse(JSON.stringify(input)), ...extra };
	const mascot = heroMascot(plan, mascotSize);
	if (mascot) out.mascot = mascot;
	return out;
}

/** Adjacent pairs [0,1], [2,3], … of screens that share a canvas size (a lone last screen stays single). */
export function panoramaPairs(plan: ComposePlan): number[][] {
	return panoramaRuns(plan, [2]);
}

/**
 * Runs of adjacent same-canvas screens with lengths cycling through `sizes` (e.g. [3, 2] → triples
 * and pairs), never leaving a lone screen when a shorter run fits.
 */
export function panoramaRuns(plan: ComposePlan, sizes: number[] = [3, 2]): number[][] {
	const explicit = plan.canvasWidth != null || plan.canvasHeight != null;
	const key = (s: ComposeScreenPlan) => {
		if (explicit) return 'explicit';
		const d = canvasDimsForDevice(s.deviceId);
		return `${d.width}x${d.height}`;
	};
	const spans: number[][] = [];
	let cycle = 0;
	for (let i = 0; i < plan.screens.length; ) {
		let len = 1;
		while (i + len < plan.screens.length && key(plan.screens[i + len]) === key(plan.screens[i])) len++;
		// `len` = same-canvas run from i; take the cycle's size, or the largest that fits.
		let take = Math.min(sizes[cycle % sizes.length], len);
		// Don't strand a single screen after this span when a smaller span would pair it up.
		if (len - take === 1 && take > 2) take = 2;
		if (take >= 2) {
			spans.push(Array.from({ length: take }, (_, k) => i + k));
			cycle++;
			i += take;
		} else i += 1;
	}
	return spans;
}

export function makeVariants(plan: ComposePlan): ComposeVariant[] {
	const common = { canvasWidth: plan.canvasWidth, canvasHeight: plan.canvasHeight, art: plan.art };
	const strip = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o)); // drops undefined keys
	const badge = (plan.style?.hero && typeof plan.style.hero === 'object' ? plan.style.hero.badge : undefined) ?? undefined;

	const a: ComposePlan = strip({
		...common,
		name: suffix(plan.name, 'A'),
		style: {
			...baseStyle(plan),
			presentation: 'device',
			palette: tonal(plan, 'vivid'),
			hero: hero(plan, { badge }),
			rhythm: { every: VARIANT_RHYTHM_EVERY, treatment: 'text-bottom' }
		},
		screens: plan.screens.map(baseScreen)
	});

	const b: ComposePlan = strip({
		...common,
		name: suffix(plan.name, 'B'),
		style: {
			...baseStyle(plan),
			// Big screenshots bleeding decisively off the bottom: the editorial "clean" look.
			bleed: plan.style?.bleed === 'none' ? 'none' : 'deep',
			presentation: 'frameless',
			palette: tonal(plan, 'light'),
			hero: hero(plan, { badge, scale: 1.3 })
		},
		screens: plan.screens.map((screen) => {
			const s = baseScreen(screen);
			// B1: only an explicit `crop` becomes a zoom card; everything else shows the full screen.
			if (screen.crop) s.presentation = 'zoom';
			return s;
		})
	});

	const pano = plan.style?.panorama;
	const spans: number[][] = pano?.spans?.length ? JSON.parse(JSON.stringify(pano.spans)) : panoramaRuns(plan);
	const decoration: Motif = pano?.decoration && pano.decoration !== 'orbs' ? pano.decoration : 'wave';
	const art = plan.art?.[0];
	const heroIndex = heroIndexOf(plan);
	const c: ComposePlan = strip({
		...common,
		name: suffix(plan.name, 'C'),
		style: {
			...baseStyle(plan),
			bleed: plan.style?.bleed === 'none' ? 'none' : 'deep',
			presentation: 'device',
			palette: tonal(plan, 'deep'),
			hero: hero(plan, { badge, tilt: plan.style?.tilt ? plan.style.tilt : VARIANT_HERO_TILT }, 0.26),
			callouts: 'none',
			// The continuous scene carries the story; a straddle only when the input asks for one
			// (a straddle needs ≥ 18% of the device on the next screen, which a focus band rarely allows).
			panorama: { spans, ...(pano?.straddle !== undefined ? { straddle: pano.straddle } : {}), decoration }
		},
		screens: plan.screens.map((screen, i) => {
			const s = baseScreen(screen);
			// The mascot travels: it crosses the first seam of every span except the hero's.
			const span = spans.find((sp) => sp[0] === i);
			if (art && span && !span.includes(heroIndex) && !s.mascot) s.mascot = { art: art.id, anchor: 'seam', size: 0.2 };
			return s;
		})
	});

	return [
		{ key: 'A', label: VARIANT_LABELS.A, plan: a },
		{ key: 'B', label: VARIANT_LABELS.B, plan: b },
		{ key: 'C', label: VARIANT_LABELS.C, plan: c }
	];
}
