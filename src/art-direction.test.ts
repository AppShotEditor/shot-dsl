/**
 * shot-dsl 0.5.0 art direction: typography, one text colour per set (WCAG), tonal palettes, hero +
 * rhythm, shadows, callouts, mascots, panorama motifs — and property sweeps that re-check the 0.4.0
 * guarantees (no tangent, focus never cropped on any edge or seam, 90% width cap + side margins)
 * on plans that use them. Geometry is re-derived from the EMITTED layer data with test-local math.
 */
import { describe, it, expect } from 'vitest';
import {
	CALLOUT_MAG,
	CALLOUT_MAX_FOCUS_COVER,
	CALLOUT_AUTO_MAX_FOCUS,
	COMPOSE_LAYOUTS,
	composeSet,
	estimateTextWidth,
	type ComposePlan,
	type ComposeScreenPlan
} from './compose';
import { breakLines, hasOrphan, overlongWords } from './typography';
import { contrastRatio, luminance } from './color';
import { hexToHsl, tonalBackground } from './palette';
import { NO_TANGENT } from './layout-system';
import { getDeviceFrame } from './device-frames';
import { MAX_HANDOFF_BYTES, handoffBytes, validateTemplate } from './validate';
import { makeVariants } from './variants';
import type { LayerJSON, ScreenLayersJSON } from './types';

type Fd = Record<string, unknown>;
const fdOf = (l: LayerJSON) => l.fabricData as Fd;
const shot = (id: string, w = 1320, h = 2868) => ({ url: `/api/screenshots/${id}/raw`, width: w, height: h });
const BEE = { id: 'bee', url: '/api/screenshots/bee/raw', width: 600, height: 600, faces: 'left' as const };
const screen = (i: number, extra: Partial<ComposeScreenPlan> = {}): ComposeScreenPlan => ({
	headline: 'Hear the word. Spell it.',
	deviceId: 'iphone_17_pro_max',
	screenshot: shot(`s${i}`),
	...extra
});
const tonalPlan = (n: number, style: ComposePlan['style'] = {}, extra: (i: number) => Partial<ComposeScreenPlan> = () => ({})): ComposePlan => ({
	name: 'T',
	art: [BEE],
	style: { palette: { mode: 'tonal', colors: ['#FFB61E', '#F57C00'] }, ...style },
	screens: Array.from({ length: n }, (_, i) => screen(i, { focus: { top: 0.3, bottom: 0.7 }, ...extra(i) }))
});
const byName = (s: ScreenLayersJSON, name: string) => s.layers.filter((l) => l.name === name);
const headline = (s: ScreenLayersJSON) => fdOf(s.layers.find((l) => l.templateKey === 'headline')!);
const subject = (s: ScreenLayersJSON) =>
	s.layers.find((l) => l.type === 'device' && !l.name.endsWith('(continued)')) ??
	s.layers.find((l) => l.type === 'image' && l.name.startsWith('Screenshot'))!;

/** Axis-aligned box of a (possibly rotated) centre-origin layer, from its fabricData only. */
function box(l: LayerJSON) {
	const f = fdOf(l);
	const w = (f.width as number) * Math.abs(f.scaleX as number);
	const h = (f.height as number) * Math.abs((f.scaleY as number) ?? (f.scaleX as number));
	const r = (((f.angle as number) ?? 0) * Math.PI) / 180;
	const bw = w * Math.abs(Math.cos(r)) + h * Math.abs(Math.sin(r));
	const bh = w * Math.abs(Math.sin(r)) + h * Math.abs(Math.cos(r));
	return { left: (f.left as number) - bw / 2, right: (f.left as number) + bw / 2, top: (f.top as number) - bh / 2, bottom: (f.top as number) + bh / 2 };
}
const overlap = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Text boxes from the emitted text layers (estimated line widths ≥ rendered widths). */
function textBoxes(s: ScreenLayersJSON) {
	return s.layers
		.filter((l) => l.type === 'text')
		.map((l) => {
			const f = fdOf(l);
			const lines = String(f.text).split('\n');
			const lh = (f.fontSize as number) * (f.lineHeight as number);
			const h = lines.length * lh;
			return lines.map((line, k) => {
				const w = Math.min(f.width as number, estimateTextWidth(line, f.fontSize as number, String(f.fontFamily)));
				const top = (f.top as number) - h / 2 + k * lh;
				return { left: (f.left as number) - w / 2, right: (f.left as number) + w / 2, top, bottom: top + lh };
			});
		})
		.flat();
}
/** Canvas points of a device/image subject's focus band corners (independent rotation math). */
function focusPts(l: LayerJSON, focus: { top: number; bottom: number }) {
	const f = fdOf(l);
	let a = { w: f.width as number, h: f.height as number, sx: 0, sy: 0, sw: f.width as number, sh: f.height as number };
	if (l.type === 'device') {
		const d = getDeviceFrame(f.deviceId as string)!;
		a = { w: d.imageDimensions.width, h: d.imageDimensions.height, sx: d.screenBounds.x, sy: d.screenBounds.y, sw: d.screenBounds.width, sh: d.screenBounds.height };
	}
	const s = f.scaleX as number;
	const r = (((f.angle as number) ?? 0) * Math.PI) / 180;
	return [
		[a.sx, a.sy + focus.top * a.sh],
		[a.sx + a.sw, a.sy + focus.top * a.sh],
		[a.sx + a.sw, a.sy + focus.bottom * a.sh],
		[a.sx, a.sy + focus.bottom * a.sh]
	].map(([x, y]) => {
		const lx = (x - a.w / 2) * s;
		const ly = (y - a.h / 2) * s;
		return { x: (f.left as number) + lx * Math.cos(r) - ly * Math.sin(r), y: (f.top as number) + lx * Math.sin(r) + ly * Math.cos(r) };
	});
}
/** Canvas bbox of the subject's region given as screenshot fractions (independent math). */
function regionRect(l: LayerJSON, fx0: number, fy0: number, fx1: number, fy1: number) {
	const pts = focusPts(l, { top: fy0, bottom: fy1 }); // corners at full screen width
	// Interpolate the x fractions along the band's top / bottom edges (the band spans the full width).
	const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
	const q = [lerp(pts[0], pts[1], fx0), lerp(pts[0], pts[1], fx1), lerp(pts[3], pts[2], fx1), lerp(pts[3], pts[2], fx0)];
	return { left: Math.min(...q.map((p) => p.x)), right: Math.max(...q.map((p) => p.x)), top: Math.min(...q.map((p) => p.y)), bottom: Math.max(...q.map((p) => p.y)) };
}
const areaOf = (r: { left: number; right: number; top: number; bottom: number }) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
const inter = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });

/** Every colour of a screen's background (solid / stops / span rect stops). */
function backgroundColors(s: ScreenLayersJSON): string[] {
	const out: string[] = [];
	const bg = s.background;
	if (bg?.type === 'gradient') out.push(...(bg.gradient?.colorStops ?? []).map((c) => c.color));
	else if (bg?.color) out.push(bg.color);
	for (const l of s.layers) {
		if (!l.name.startsWith('Panorama background')) continue;
		const fill = fdOf(l).fill as Fd | string;
		if (typeof fill === 'string') out.push(fill);
		else out.push(...(fill.colorStops as Array<{ color: string }>).map((c) => c.color));
	}
	return out;
}

describe('typography — line breaking by meaning', () => {
	const width = (size: number) => (line: string) => estimateTextWidth(line, size);
	it('never strands a single short word on the last line when the copy can be balanced', () => {
		for (const text of ['A new puzzle every day.', 'Hear the word. Spell it.', 'The hard words come back.', 'Watch them improve.', 'Words for their grade.', 'This week’s spelling list.']) {
			const lines = breakLines(text, 246, width(24));
			expect(hasOrphan(lines), `${text} → ${JSON.stringify(lines)}`).toBe(false);
			expect(lines.join(' ')).toBe(text);
			for (const line of lines) expect(width(24)(line)).toBeLessThanOrEqual(246);
		}
	});
	it('balances instead of greedy-filling, and prefers a break after punctuation', () => {
		expect(breakLines('Hear the word. Spell it.', 246, width(24))).toEqual(['Hear the word.', 'Spell it.']);
		const lines = breakLines('Every word read aloud with a big letter pad', 200, width(14));
		const ws = lines.map(width(14));
		expect(Math.max(...ws) - Math.min(...ws)).toBeLessThan(0.35 * 200);
	});
	it('M3: explicit \\n lines are ALWAYS kept — never merged, only an over-wide line is broken further', () => {
		expect(breakLines('Ace every\nspelling test', 246, width(24))).toEqual(['Ace every', 'spelling test']);
		// Short copy that would fit on one line keeps the author's break.
		expect(breakLines('Hear it.\nSpell it.', 246, width(24))).toEqual(['Hear it.', 'Spell it.']);
		expect(breakLines('Hear the word.\nSpell it.\nWin.', 246, width(24))).toEqual(['Hear the word.', 'Spell it.', 'Win.']);
		// An explicit line wider than the box is balanced within itself; the other line is untouched.
		const lines = breakLines('18 games that\nmake practice fun and easy', 200, width(24));
		expect(lines[0]).toBe('18 games that');
		expect(lines.slice(1).join(' ')).toBe('make practice fun and easy');
		expect(lines.length).toBeGreaterThan(2);
	});
	it('M3: explicit breaks are identical on every device and on hero vs set screens', () => {
		for (const deviceId of ['iphone_17_pro_max', 'ipad_pro_13_m4', 'macbook_pro_14']) {
			const { report } = composeSet({
				name: 'M3',
				style: { palette: { mode: 'tonal', colors: ['#FFB61E'] } },
				screens: [0, 1].map((i) => screen(i, { deviceId, headline: 'Ace every\nspelling test', screenshot: deviceId.startsWith('ipad') ? shot(`s${i}`, 2064, 2752) : deviceId.startsWith('mac') ? shot(`s${i}`, 3024, 1964) : shot(`s${i}`) }))
			});
			expect(report.screens[0].role).toBe('hero');
			for (const m of report.screens) expect(m.headlineLines, `${deviceId} ${m.role}`).toEqual(['Ace every', 'spelling test']);
		}
	});
	it('long copy fails fast: 200 words break greedily past MAX_BALANCED_TOKENS (well under 1 s)', () => {
		const long = Array.from({ length: 200 }, (_, i) => `word${i % 7}`).join(' ');
		const t0 = performance.now();
		const lines = breakLines(long, 246, width(24));
		expect(performance.now() - t0).toBeLessThan(500);
		expect(lines.join(' ')).toBe(long);
		const t1 = performance.now();
		expect(() => composeSet({ name: 'L', screens: [screen(0, { headline: long, background: { type: 'solid', color: '#123456' } })] })).toThrow(/copy too long/);
		expect(performance.now() - t1).toBeLessThan(1000);
	});
	it('CJK is measured ~1 em per glyph and breaks between glyphs (no Textbox overflow)', () => {
		const size = 24;
		const cjk = '学习拼写更轻松每天进步一点点';
		expect(estimateTextWidth('学', size)).toBeGreaterThanOrEqual(size); // ≥ 1 em
		const lines = breakLines(cjk, 150, width(size));
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join('')).toBe(cjk);
		for (const line of lines) expect(width(size)(line)).toBeLessThanOrEqual(150);
	});
	it('a word wider than the text box is a clear error (Fabric would widen the box past the margins)', () => {
		expect(() =>
			composeSet({ name: 'W', screens: [screen(0, { headline: 'Supercalifragilisticexpialidociously', background: { type: 'solid', color: '#123456' } })] })
		).toThrow(/wider than the text box/);
		expect(overlongWords('a Supercalifragilisticexpialidociously b', 246, width(24))).toEqual(['Supercalifragilisticexpialidociously']);
	});
	it('the composer emits the chosen breaks as \\n (the editor shows exactly these lines)', () => {
		const { template, report } = composeSet({ name: 'B', style: { hero: false }, screens: [screen(0, { headline: 'A new puzzle every day.', background: { type: 'solid', color: '#123456' } })] });
		expect(headline(template.screens[0]).text).toBe(report.screens[0].headlineLines.join('\n'));
		expect(report.warnings.map((w) => w.code)).not.toContain('headline-orphan');
	});
	it('subheadline: ~50% of the headline, weight 600, full opacity', () => {
		const { template } = composeSet({ name: 'S', style: { hero: false }, screens: [screen(0, { subheadline: 'Every word read aloud', background: { type: 'solid', color: '#123456' } })] });
		const h = headline(template.screens[0]);
		const sub = fdOf(template.screens[0].layers.find((l) => l.templateKey === 'subheadline')!);
		expect((sub.fontSize as number) / (h.fontSize as number)).toBeGreaterThanOrEqual(0.45);
		expect((sub.fontSize as number) / (h.fontSize as number)).toBeLessThanOrEqual(0.55);
		expect(sub.fontWeight).toBe('600');
		expect(sub.opacity).toBeUndefined();
	});
});

describe('palette — ONE text colour per set, WCAG ≥ 4.5 on every palette background (B2)', () => {
	const bases = ['#FFB61E', '#FF9500', '#2E6FD8', '#6C2BC4', '#1E9E63', '#FF4E73', '#111111', '#F5F5F5', '#00C2FF', '#8B5A2B'];
	it('sweep: tonal (every tone) and family/sequence palettes', () => {
		let checked = 0;
		const palettes: Array<NonNullable<ComposePlan['style']>['palette']> = [
			...bases.flatMap((b) => (['light', 'vivid', 'deep'] as const).map((tone) => ({ mode: 'tonal' as const, colors: [b], tone }))),
			{ mode: 'sequence', colors: ['#F77E1B', '#2E6FD8', '#6C2BC4', '#FF4E73', '#1E9E63'] },
			{ mode: 'family', colors: ['#FFE600', '#1A1AFF'] },
			{ mode: 'sequence', colors: ['#FFFFFF', '#000000'] }
		];
		for (const palette of palettes) {
			for (const spans of [[], [[0, 1, 2], [3, 4]]]) {
				const { template, report } = composeSet({
					name: 'P',
					style: { palette, panorama: spans.length ? { spans } : undefined },
					screens: [0, 1, 2, 3, 4].map((i) => screen(i))
				});
				const where = `${JSON.stringify(palette)} spans=${spans.length}`;
				const colors = new Set(template.screens.map((s) => headline(s).fill));
				expect(colors.size, where).toBe(1);
				const text = [...colors][0] as string;
				for (const [i, s] of template.screens.entries()) {
					for (const c of backgroundColors(s)) expect(contrastRatio(text, c), `${where} screen ${i} ${c}`).toBeGreaterThanOrEqual(4.5);
					expect(report.screens[i].contrast, where).toBeGreaterThanOrEqual(4.5);
				}
				expect(report.warnings.map((w) => w.code), where).not.toContain('contrast-low');
				checked++;
			}
		}
		expect(checked).toBe(palettes.length * 2);
	});
	it('tonal text is a tint of the brand hue, not a neutral grey; backgrounds stay in the hue family', () => {
		const { template, report } = composeSet(tonalPlan(4));
		const text = report.screens[0].textColor;
		expect(hexToHsl(text).s).toBeGreaterThan(0.2);
		expect(Math.abs(hexToHsl(text).h - hexToHsl('#FFB61E').h)).toBeLessThan(15);
		for (const s of template.screens) for (const c of backgroundColors(s)) expect(Math.abs(hexToHsl(c).h - hexToHsl('#FFB61E').h)).toBeLessThan(20);
	});
	it('tones: light is pale, deep is darker than vivid', () => {
		const mid = (tone: 'light' | 'vivid' | 'deep') => luminance(tonalBackground('#FFB61E', tone, 0).gradient!.colorStops[0].color);
		expect(mid('light')).toBeGreaterThan(mid('vivid'));
		expect(mid('vivid')).toBeGreaterThan(mid('deep'));
	});
	it('M1 (review repro): a light tonal palette + one dark explicit background — never sub-AA text', () => {
		const { template, report } = composeSet({
			name: 'E',
			style: { palette: { mode: 'tonal', colors: ['#FFB61E'], tone: 'light' } },
			screens: [screen(0), screen(1), screen(2, { background: { type: 'solid', color: '#1F2937' } })]
		});
		// Explicit backgrounds are never recoloured…
		expect(template.screens[2].background).toEqual({ type: 'solid', color: '#1F2937' });
		// …no single colour passes on both, so only that screen gets its own readable colour.
		expect(report.screens.map((m) => m.textColorSource)).toEqual(['set', 'set', 'screen']);
		expect(report.screens[0].textColor).toBe(report.screens[1].textColor);
		for (const m of report.screens) expect(m.contrast).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(String(headline(template.screens[2]).fill), '#1F2937')).toBeGreaterThanOrEqual(4.5);
		expect(report.warnings.map((w) => w.code)).not.toContain('contrast-low');
	});
	it('M1: explicit backgrounds take part in choosing the set colour when one colour can pass everywhere', () => {
		// Vivid honey palette + a pale explicit background: dark text passes on all → ONE colour.
		const { report } = composeSet({
			name: 'E2',
			style: { palette: { mode: 'tonal', colors: ['#FFB61E'] } },
			screens: [screen(0), screen(1, { background: { type: 'solid', color: '#FFF4D6' } })]
		});
		expect(report.screens.map((m) => m.textColorSource)).toEqual(['set', 'set']);
		expect(report.screens[0].textColor).toBe(report.screens[1].textColor);
		expect(report.screens.every((m) => m.contrast >= 4.5)).toBe(true);
	});
	it('M1: an explicit-only set keeps white when white works (0.4.0), else picks the dark text', () => {
		const dark = composeSet({ name: 'D', style: { hero: false }, screens: [screen(0, { background: { type: 'solid', color: '#123456' } })] }).report;
		expect(dark.screens[0].textColor.toLowerCase()).toBe('#ffffff');
		const pale = composeSet({ name: 'P', style: { hero: false }, screens: [screen(0, { background: { type: 'solid', color: '#F5F5F5' } })] }).report;
		expect(pale.screens[0].contrast).toBeGreaterThanOrEqual(4.5);
	});
});

describe('hero + rhythm', () => {
	it('default hero: screen 1, larger type (≈1.25×), its own group, deep bleed; `hero: false` turns it off', () => {
		const on = composeSet(tonalPlan(4, {}, () => ({ headline: 'Spell it.' })));
		expect(on.report.screens.map((m) => m.role)).toEqual(['hero', 'set', 'set', 'set']);
		expect(on.report.screens[0].headlineSize / on.report.screens[1].headlineSize).toBeCloseTo(1.25, 6);
		expect(on.report.screens[0].group).not.toBe(on.report.screens[1].group);
		expect(on.report.screens[0].group).toContain('bleed:deep');
		const off = composeSet(tonalPlan(4, { hero: false }, () => ({ headline: 'Spell it.' })));
		expect(off.report.screens.every((m) => m.role === 'set')).toBe(true);
		expect(new Set(off.report.screens.map((m) => m.group)).size).toBe(1);
	});
	it('the hero scale never adds a headline line (steps down instead)', () => {
		const { report } = composeSet(tonalPlan(2, {}, () => ({ headline: 'Their school list, ready in seconds' })));
		expect(report.screens[0].headlineLines.length).toBeLessThanOrEqual(Math.max(2, report.screens[1].headlineLines.length));
	});
	it('hero badge + mascot; the badge row is reserved on the hero only', () => {
		const { template, report } = composeSet(tonalPlan(3, { hero: { badge: 'Grades 1–12', mascot: { art: 'bee' } } }));
		expect(byName(template.screens[0], 'Badge')).toHaveLength(1);
		expect(byName(template.screens[1], 'Badge')).toHaveLength(0);
		expect(byName(template.screens[0], 'Mascot')).toHaveLength(1);
		expect(report.screens[1].headlineTop).toBeLessThan(report.screens[0].headlineTop + 1e-9);
	});
	it('rhythm: every Nth screen is an accent (text-bottom); the rest keep ONE shared system', () => {
		const { report } = composeSet(tonalPlan(9, { rhythm: { every: 4 } }));
		expect(report.screens.map((m) => m.role)).toEqual(['hero', 'set', 'set', 'accent', 'set', 'set', 'set', 'accent', 'set']);
		expect(report.screens.filter((m) => m.role === 'accent').every((m) => m.layout === 'text-bottom')).toBe(true);
		const set = report.screens.filter((m) => m.role === 'set');
		expect(new Set(set.map((m) => m.group)).size).toBe(1);
		expect(new Set(set.map((m) => m.scale)).size).toBe(1);
		expect(new Set(set.map((m) => m.headlineTop.toFixed(9))).size).toBe(1);
		expect(new Set(report.screens.filter((m) => m.role !== 'hero').map((m) => m.headlineSize)).size).toBe(1);
	});
	it('rhythm `callout` accents get a callout (forced from focus) and a deeper bleed', () => {
		const { report } = composeSet(tonalPlan(4, { rhythm: { every: 3, treatment: 'callout' } }, () => ({ focus: { top: 0.2, bottom: 0.9 } })));
		expect(report.screens[2].role).toBe('accent');
		expect(report.screens[2].callout).toBeDefined();
		expect(report.screens[1].callout).toBeUndefined();
	});
});

describe('shadows', () => {
	it('device frames carry deviceShadow (canvas units); frameless, callouts and mascots carry Fabric shadows', () => {
		const framed = composeSet(tonalPlan(2, { hero: { mascot: { art: 'bee' } } }, (i) => (i === 1 ? { callout: { x: 0.1, y: 0.4, w: 0.5, h: 0.1 } } : {}))).template;
		const dev = fdOf(subject(framed.screens[0]));
		expect(dev.deviceShadow).toMatchObject({ offsetX: 0 });
		expect((dev.deviceShadow as Fd).blur as number).toBeGreaterThan(0);
		expect(dev.shadow).toBeUndefined(); // never on the frame PNG itself (its screen hole would catch it)
		expect(fdOf(byName(framed.screens[0], 'Mascot')[0]).shadow).toBeDefined();
		expect(fdOf(byName(framed.screens[1], 'Callout')[0]).shadow).toBeDefined();
		const frameless = composeSet(tonalPlan(1, { presentation: 'frameless' })).template;
		expect(fdOf(subject(frameless.screens[0])).shadow).toBeDefined();
		const none = composeSet(tonalPlan(1, { shadows: false })).template;
		expect(fdOf(subject(none.screens[0])).deviceShadow).toBeUndefined();
	});
});

describe('callouts', () => {
	it('explicit callout: a magnified crop of the SAME uploaded screenshot, rounded, over the device, under the text', () => {
		const { template, report } = composeSet(tonalPlan(2, { hero: false }, () => ({ callout: { x: 0.05, y: 0.36, w: 0.6, h: 0.08 } })));
		const s = template.screens[0];
		const [c] = byName(s, 'Callout');
		const f = fdOf(c);
		expect(f.src).toBe('/api/screenshots/s0/raw');
		// The crop is padded outward from the requested region (Fix: keeps the rounded mask from
		// clipping content at the requested crop's own corners) — see the dedicated padding test below.
		expect(f.cropX as number).toBeLessThanOrEqual(0.05 * 1320);
		expect(f.cropY as number).toBeLessThanOrEqual(0.36 * 2868);
		expect(f.cropX as number).toBeGreaterThanOrEqual(0);
		expect(f.cropY as number).toBeGreaterThanOrEqual(0);
		expect((f.cropX as number) + (f.width as number)).toBeGreaterThanOrEqual(0.05 * 1320 + 0.6 * 1320);
		expect((f.cropY as number) + (f.height as number)).toBeGreaterThanOrEqual(0.36 * 2868 + 0.08 * 2868);
		expect((f.clipPath as Fd).rx as number).toBeGreaterThan(0);
		const mag = report.screens[0].callout!.magnification;
		expect(mag).toBeGreaterThanOrEqual(CALLOUT_MAG.floor);
		expect(mag).toBeLessThanOrEqual(CALLOUT_MAG.max);
		const idx = (l: LayerJSON) => s.layers.indexOf(l);
		expect(idx(c)).toBeGreaterThan(idx(subject(s)));
		expect(idx(c)).toBeLessThan(idx(s.layers.find((l) => l.templateKey === 'headline')!));
		expect(validateTemplate(template)).toEqual({ valid: true, errors: [] });
	});
	it('the crop is padded so the requested crop’s own corners fall inside the rounded mask, not just its edges', () => {
		// Geometric minimum to keep a corner point inside a rounded corner of local radius `rx` is
		// `1 - 1/√2 ≈ 0.293 × rx` (see CALLOUT_CORNER_PAD / the hard cap in makeCalloutLayer, both in
		// compose.ts). Assert it on every side that isn't clamped against the screenshot's own edge
		// (clamping there is fine — the image edge already bounds it) — a small sweep of crop shapes,
		// including a tall one that (pre-fix) under-padded to ~0.287×rx against the 0.293 minimum
		// because the fit caps + placement search can shrink the final magnification below the
		// preliminary estimate the padding was sized from.
		const shotW = 1320;
		const shotH = 2868;
		const cases = [
			{ x: 0.05, y: 0.36, w: 0.6, h: 0.08 }, // wide, shallow
			{ x: 0.05, y: 0.3, w: 0.5, h: 0.3 }, // tall — the regression case
			{ x: 0.1, y: 0.4, w: 0.3, h: 0.25 }, // squarer
			{ x: 0.02, y: 0.05, w: 0.4, h: 0.15 } // near the top edge — some sides may clamp
		];
		for (const req of cases) {
			const where = JSON.stringify(req);
			const { template } = composeSet(tonalPlan(2, { hero: false }, () => ({ callout: req })));
			const callouts = byName(template.screens[0], 'Callout');
			expect(callouts, where).toHaveLength(1);
			const f = fdOf(callouts[0]);
			const cropX = f.cropX as number;
			const cropY = f.cropY as number;
			const cropW = f.width as number;
			const cropH = f.height as number;
			const rxLocal = (f.clipPath as Fd).rx as number;
			const minMargin = (1 - 1 / Math.SQRT2) * rxLocal;
			const requested = { x: req.x * shotW, y: req.y * shotH, w: req.w * shotW, h: req.h * shotH };
			// the padded crop always contains the requested crop
			expect(cropX, where).toBeLessThanOrEqual(requested.x);
			expect(cropY, where).toBeLessThanOrEqual(requested.y);
			expect(cropX + cropW, where).toBeGreaterThanOrEqual(requested.x + requested.w);
			expect(cropY + cropH, where).toBeGreaterThanOrEqual(requested.y + requested.h);
			// …with at least the geometric-minimum margin on any side not clamped to the screenshot edge
			if (cropX > 1e-6) expect(requested.x - cropX, `${where} left`).toBeGreaterThanOrEqual(minMargin - 1e-6);
			if (cropY > 1e-6) expect(requested.y - cropY, `${where} top`).toBeGreaterThanOrEqual(minMargin - 1e-6);
			if (cropX + cropW < shotW - 1e-6) expect(cropX + cropW - (requested.x + requested.w), `${where} right`).toBeGreaterThanOrEqual(minMargin - 1e-6);
			if (cropY + cropH < shotH - 1e-6) expect(cropY + cropH - (requested.y + requested.h), `${where} bottom`).toBeGreaterThanOrEqual(minMargin - 1e-6);
		}
	});
	it('auto: only on screens with a tight focus band; `callout: false` opts out; never on the hero or zoom cards', () => {
		const { report } = composeSet(
			tonalPlan(5, { callouts: 'auto' }, (i) => ({
				focus: i === 2 ? { top: 0.1, bottom: 0.95 } : { top: 0.3, bottom: 0.3 + CALLOUT_AUTO_MAX_FOCUS - 0.05 },
				...(i === 3 ? { callout: false as const } : {}),
				...(i === 4 ? { presentation: 'zoom' as const } : {})
			}))
		);
		expect(report.screens.map((m) => !!m.callout)).toEqual([false, true, false, false, false]);
	});
	it('a crop too large to magnify is skipped with a warning', () => {
		const { report } = composeSet(tonalPlan(2, { hero: false }, () => ({ callout: { x: 0, y: 0.2, w: 1, h: 0.2 } })));
		expect(report.screens[0].callout).toBeUndefined();
		expect(report.warnings.map((w) => w.code)).toContain('callout-skipped');
	});
});

describe('mascot / brand art', () => {
	it('art must be an uploaded asset; unknown art ids are errors', () => {
		expect(() => composeSet({ ...tonalPlan(1), art: [{ ...BEE, url: 'https://evil.example/bee.png' }] })).toThrow(/uploaded asset/);
		expect(() => composeSet(tonalPlan(1, {}, () => ({ mascot: { art: 'nope' } })))).toThrow(/not in plan.art/);
	});
	it('flips to face into the canvas when the art declares which way it faces', () => {
		const { template, report } = composeSet(tonalPlan(1, { hero: { mascot: { art: 'bee' } } }));
		const f = fdOf(byName(template.screens[0], 'Mascot')[0]);
		const onRight = ((report.screens[0].mascot!.left + report.screens[0].mascot!.right) / 2) > 140;
		// BEE faces left: on the right half it already faces in (no flip); on the left half it flips.
		expect(!!f.flipX).toBe(!onRight);
	});
	it('seam anchor: one mascot crossing the seam, emitted on both screens at seam-aligned offsets', () => {
		const { template } = composeSet(tonalPlan(2, { hero: false, panorama: { spans: [[0, 1]], decoration: 'honeycomb' } }, (i) => (i === 0 ? { mascot: { art: 'bee', anchor: 'seam' } } : {})));
		const own = fdOf(byName(template.screens[0], 'Mascot')[0]);
		const cont = fdOf(byName(template.screens[1], 'Mascot (continued)')[0]);
		expect(cont.left as number).toBeCloseTo((own.left as number) - 280, 9);
		expect(cont.top).toBe(own.top);
		const b = box(byName(template.screens[0], 'Mascot')[0]);
		expect(b.left).toBeLessThan(280);
		expect(b.right).toBeGreaterThan(280);
	});
});

describe('panorama scene', () => {
	it('H1: each screen carries only ITS part of the motif (0.1-unit coords), and the parts meet exactly at the seams', () => {
		for (const decoration of ['honeycomb', 'wave'] as const) {
			const { template } = composeSet(tonalPlan(3, { panorama: { spans: [[0, 1, 2]], decoration } }));
			const motifs = template.screens.map((s) => fdOf(s.layers.find((l) => l.name.startsWith('Panorama motif'))!));
			expect(motifs.every((m) => m.type === 'Path')).toBe(true);
			const pts = (m: Fd) => (m.path as Array<[string, number, number]>).filter((c) => c.length >= 3).map((c) => [c[1], c[2]] as const);
			for (const m of motifs) {
				const p = pts(m);
				// Rounded to 0.1 unit…
				expect(p.every(([x, y]) => Math.abs(x * 10 - Math.round(x * 10)) < 1e-6 && Math.abs(y * 10 - Math.round(y * 10)) < 1e-6)).toBe(true);
				// …positioned by the bbox centre (how Fabric centres a Path)…
				const xs = p.map(([x]) => x);
				const ys = p.map(([, y]) => y);
				expect(m.left as number).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 9);
				expect(m.top as number).toBeCloseTo((Math.min(...ys) + Math.max(...ys)) / 2, 9);
				// …and limited to this screen plus a small overdraw (no N·W path per screen).
				expect(Math.min(...xs)).toBeGreaterThan(-0.3 * 280);
				expect(Math.max(...xs)).toBeLessThan(1.3 * 280);
			}
			// Seam continuity: the geometry around each seam is identical on both neighbours (±W).
			for (const k of [0, 1]) {
				const key = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;
				const near = (list: ReadonlyArray<readonly [number, number]>, dx: number) =>
					new Set(list.map(([x, y]) => [x + dx, y] as const).filter(([x]) => Math.abs(x - 280) <= 2).map(([x, y]) => key(x, y)));
				const a = near(pts(motifs[k]), 0);
				const b = near(pts(motifs[k + 1]), 280);
				expect(a.size, `${decoration} seam ${k}`).toBeGreaterThan(0);
				expect([...a].sort()).toEqual([...b].sort());
			}
			expect(validateTemplate(template).valid).toBe(true);
		}
	});
	it('H1: worst-case handoffs stay under the server cap (sizes reported)', () => {
		const dev = [
			['iphone_17_pro_max', 1320, 2868],
			['ipad_pro_13_m4', 2064, 2752],
			['macbook_pro_14', 3024, 1964]
		] as const;
		const big = (n: number, groups: number): ComposePlan => ({
			name: 'Big',
			art: [BEE],
			style: { palette: { mode: 'tonal', colors: ['#FFB61E'] }, panorama: { decoration: 'honeycomb' } },
			screens: Array.from({ length: n }, (_, i) => {
				const d = dev[Math.floor(i / Math.ceil(n / groups))];
				return screen(i, { deviceId: d[0], screenshot: shot(`s${i}`, d[1], d[2]), subheadline: 'Every word read aloud', focus: { top: 0.3, bottom: 0.7 } });
			})
		});
		const sizes: Record<string, number> = {
			'30 screens phone+iPad+Mac, C honeycomb': handoffBytes(composeSet(makeVariants(big(30, 3))[2].plan).template),
			'20 screens phone+iPad, C honeycomb': handoffBytes(composeSet(makeVariants(big(20, 2))[2].plan).template),
			'8-screen user span, honeycomb': handoffBytes(composeSet({ ...big(8, 1), style: { palette: { mode: 'tonal', colors: ['#FFB61E'] }, panorama: { spans: [[0, 1, 2, 3, 4, 5, 6, 7]], decoration: 'honeycomb' } } }).template),
			'10-screen user span, wave': handoffBytes(composeSet({ ...big(10, 1), style: { palette: { mode: 'tonal', colors: ['#FFB61E'] }, panorama: { spans: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]], decoration: 'wave' } } }).template)
		};
		(globalThis as unknown as { __handoffSizes?: unknown }).__handoffSizes = sizes;
		for (const [label, bytes] of Object.entries(sizes)) expect(bytes, `${label}: ${bytes} bytes`).toBeLessThan(0.8 * MAX_HANDOFF_BYTES);
	});
});

describe('property sweep — 0.4.0 guarantees hold with hero, callouts and mascots', () => {
	const focuses = [{ top: 0.3, bottom: 0.7 }, { top: 0, bottom: 1 }, { top: 0.05, bottom: 0.35 }, { top: 0.6, bottom: 0.98 }];
	const callouts = [undefined, { x: 0.05, y: 0.35, w: 0.6, h: 0.08 }, { x: 0.3, y: 0.62, w: 0.4, h: 0.2 }];
	const anchors = ['headline', 'device-top', 'device-side', 'seam'] as const;
	it('no tangent, focus inside every edge, width cap + side margins; callouts/mascots clear text and focus', () => {
		let checked = 0;
		let callouts_ = 0;
		let mascots = 0;
		for (const deviceId of ['iphone_17_pro_max', 'ipad_pro_13_m4']) {
			for (const presentation of ['device', 'frameless'] as const) {
				for (const layout of COMPOSE_LAYOUTS) {
					for (const [fi, focus] of focuses.entries()) {
						for (const callout of callouts) {
							const anchor = anchors[(fi + checked) % anchors.length];
							const tilt = fi === 1 ? 8 : 0;
							const plan: ComposePlan = {
								name: 'S',
								art: [BEE],
								style: {
									presentation,
									palette: { mode: 'tonal', colors: ['#FFB61E'] },
									hero: { badge: 'Grades 1–12', mascot: { art: 'bee', anchor: anchor === 'seam' ? 'headline' : anchor }, tilt },
									rhythm: { every: 3 },
									panorama: { spans: [[1, 2]], decoration: 'honeycomb' }
								},
								screens: [0, 1, 2, 3].map((i) =>
									screen(i, {
										deviceId,
										layout,
										focus,
										callout,
										headline: i % 2 ? 'Hear the word. Spell it.' : 'Words for every grade',
										subheadline: i === 2 ? 'Every word read aloud' : undefined,
										screenshot: deviceId.startsWith('ipad') ? shot(`s${i}`, 2064, 2752) : shot(`s${i}`),
										...(i === 1 || i === 2 ? { mascot: { art: 'bee', anchor: i === 2 ? 'headline' : anchor } } : {})
									})
								)
							};
							const { template, report } = composeSet(plan);
							const where = `${deviceId} ${presentation} ${layout} f=${JSON.stringify(focus)} c=${JSON.stringify(callout)} ${anchor}`;
							expect(validateTemplate(template).errors, where).toEqual([]);
							for (const [i, s] of template.screens.entries()) {
								const W = s.canvasWidth!;
								const H = s.canvasHeight!;
								const m = report.screens[i];
								expect(m.tangent, where).toBe(false);
								expect(m.widthFraction, where).toBeLessThanOrEqual(NO_TANGENT.maxWidth + 1e-9);
								expect(m.contrast, where).toBeGreaterThanOrEqual(4.5);
								const subj = subject(s);
								for (const p of focusPts(subj, focus)) {
									expect(p.x, `${where} #${i} focus x`).toBeGreaterThanOrEqual(NO_TANGENT.focusSideSafe * W - 1e-6);
									expect(p.x, `${where} #${i} focus x`).toBeLessThanOrEqual(W * (1 - NO_TANGENT.focusSideSafe) + 1e-6);
									expect(p.y, `${where} #${i} focus y`).toBeGreaterThanOrEqual(NO_TANGENT.focusSafe * H - 1e-6);
									expect(p.y, `${where} #${i} focus y`).toBeLessThanOrEqual(H * (1 - NO_TANGENT.focusSafe) + 1e-6);
								}
								const texts = textBoxes(s);
								for (const c of byName(s, 'Callout')) {
									callouts_++;
									const b = box(c);
									// M2: the card hides ≤ 35% of the focus band outside its own source slice.
									const f = fdOf(c);
									const nat = plan.screens[i].screenshot;
									const fr = regionRect(subj, 0, focus.top, 1, focus.bottom);
									const band = { left: Math.max(0, fr.left), right: Math.min(W, fr.right), top: Math.max(0, fr.top), bottom: Math.min(H, fr.bottom) };
									// The REQUESTED crop (fractions), not the padded one the layer now carries (Fix: the crop
									// is padded outward so the rounded mask doesn't clip the requested crop's own corners) —
									// `CALLOUT_MAX_FOCUS_COVER` is enforced against the requested source slice.
									const req = callout!;
									const src = regionRect(subj, req.x, req.y, req.x + req.w, req.y + req.h);
									const rest = areaOf(band) - areaOf(inter(band, src));
									const cb = inter(b, band);
									const hidden = rest > 1e-6 ? (areaOf(cb) - areaOf(inter(cb, src))) / rest : 0;
									expect(hidden, `${where} #${i} callout hides focus`).toBeLessThanOrEqual(CALLOUT_MAX_FOCUS_COVER + 1e-6);
									expect(b.left, where).toBeGreaterThanOrEqual(0.03 * W - 1e-6);
									expect(b.right, where).toBeLessThanOrEqual(0.97 * W + 1e-6);
									expect(b.top, where).toBeGreaterThanOrEqual(0.03 * H - 1e-6);
									expect(b.bottom, where).toBeLessThanOrEqual(0.97 * H + 1e-6);
									for (const t of texts) expect(overlap(b, t), `${where} #${i} callout vs text`).toBe(false);
									// The crop stays inside the screenshot it magnifies.
									const natural = nat;
									expect((f.cropX as number) + (f.width as number), where).toBeLessThanOrEqual(natural.width + 1e-6);
									expect((f.cropY as number) + (f.height as number), where).toBeLessThanOrEqual(natural.height + 1e-6);
								}
								const allMascots = [...byName(s, 'Mascot'), ...byName(s, 'Mascot (continued)')];
								for (const [mi, mascot] of allMascots.entries()) {
									mascots++;
									const b = box(mascot);
									for (const other of allMascots.slice(mi + 1)) expect(overlap(b, box(other)), `${where} #${i} mascot vs mascot`).toBe(false);
									for (const t of texts) expect(overlap(b, t), `${where} #${i} mascot vs text`).toBe(false);
									for (const c of byName(s, 'Callout')) expect(overlap(b, box(c)), `${where} #${i} mascot vs callout`).toBe(false);
									expect(b.top, where).toBeGreaterThanOrEqual(0);
									expect(b.bottom, where).toBeLessThanOrEqual(H);
								}
							}
							// Determinism: the same plan composes to the same geometry (ids aside).
							const again = composeSet(plan).report;
							expect(again.screens, where).toEqual(report.screens);
							checked++;
						}
					}
				}
			}
		}
		expect(checked).toBe(2 * 2 * 3 * 4 * 3);
		expect(callouts_).toBeGreaterThan(50);
		expect(mascots).toBeGreaterThan(50);
	}, 30_000); // CPU-heavy sweep: ~2s alone, can exceed the 5s default under full-suite parallel load
});

describe('review fixes — M1 sweep, badges, mascots', () => {
	it('M1 sweep: palettes mixed with explicit backgrounds — every screen ≥ 4.5 (own colour only on explicit screens)', () => {
		const explicit = ['#1F2937', '#FFFFFF', '#F5F5F5', '#777777', '#E91E63', '#00C2FF', '#123456', '#FFE600'];
		let own = 0;
		for (const tone of ['light', 'vivid', 'deep'] as const) {
			for (const base of ['#FFB61E', '#2E6FD8', '#6C2BC4']) {
				for (const bg of explicit) {
					const { report } = composeSet({
						name: 'M',
						style: { palette: { mode: 'tonal', colors: [base], tone } },
						screens: [screen(0), screen(1, { background: { type: 'solid', color: bg } }), screen(2)]
					});
					const where = `${tone} ${base} + ${bg}`;
					const setColors = new Set(report.screens.filter((m) => m.textColorSource === 'set').map((m) => m.textColor));
					expect(setColors.size, where).toBe(1);
					expect(report.screens[0].textColorSource, where).toBe('set');
					expect(report.screens[2].textColorSource, where).toBe('set');
					for (const m of report.screens) {
						const warned = report.warnings.some((w) => w.code === 'contrast-low' && w.screen === m.index);
						// Never silent: ≥ 4.5, or (only if no colour at all can reach it) a warning.
						expect(m.contrast >= 4.5 || warned, `${where} #${m.index} ${m.contrast}`).toBe(true);
					}
					if (report.screens[1].textColorSource === 'screen') own++;
				}
			}
		}
		expect(own).toBeGreaterThan(0);
	});
	it('M1 residual (review repro): explicit fills inside panorama spans get ONE readable colour per span', () => {
		const solid = (color: string) => ({ type: 'solid' as const, color });
		const { template, report } = composeSet({
			name: 'S',
			style: { hero: false, panorama: { spans: [[0, 1], [2, 3]] } },
			screens: ['#00C853', '#00C853', '#7E57C2', '#7E57C2'].map((c, i) => screen(i, { background: solid(c) }))
		});
		for (const m of report.screens) expect(m.contrast, `#${m.index}`).toBeGreaterThanOrEqual(4.5);
		expect(report.warnings.map((w) => w.code)).not.toContain('contrast-low');
		// One colour per span (the scene stays consistent).
		expect(report.screens[2].textColor).toBe(report.screens[3].textColor);
		expect(report.screens[0].textColor).toBe(report.screens[1].textColor);
		expect(contrastRatio(String(headline(template.screens[3]).fill), '#7E57C2')).toBeGreaterThanOrEqual(4.5);
	});
	it('M1 sweep: spans with explicit fills (and palettes around them) — ≥ 4.5 or warned, one colour per span', () => {
		const fills = ['#00C853', '#7E57C2', '#FFE600', '#1F2937', '#F5F5F5', '#E91E63', '#777777', '#00C2FF'];
		let checked = 0;
		for (const withPalette of [false, true]) {
			for (let a = 0; a < fills.length; a++) {
				for (let b = 0; b < fills.length; b++) {
					const bg = (c: string) => ({ type: 'solid' as const, color: c });
					const { template, report } = composeSet({
						name: 'S',
						style: { hero: false, ...(withPalette ? { palette: { mode: 'tonal' as const, colors: ['#FFB61E'] } } : {}), panorama: { spans: [[0, 1], [2, 3]] } },
						screens: [
							screen(0, { background: bg(fills[a]), subheadline: 'Every word read aloud' }),
							screen(1, { background: bg(fills[a]) }),
							screen(2, { background: bg(fills[b]), subheadline: 'Every word read aloud' }),
							screen(3, { background: bg(fills[b]) }),
							screen(4, withPalette ? { subheadline: 'Every word read aloud' } : { background: bg('#123456') })
						]
					});
					const where = `${withPalette} ${fills[a]} ${fills[b]}`;
					expect(report.screens[0].textColor, where).toBe(report.screens[1].textColor);
					expect(report.screens[2].textColor, where).toBe(report.screens[3].textColor);
					for (const [i, s] of template.screens.entries()) {
						const warned = report.warnings.some((w) => w.code === 'contrast-low' && w.screen === i);
						expect(report.screens[i].contrast >= 4.5 || warned, `${where} #${i}`).toBe(true);
						const sub = s.layers.find((l) => l.templateKey === 'subheadline');
						if (sub) {
							const fill = String(fdOf(sub).fill);
							const ok = backgroundColors(s).every((c) => contrastRatio(fill, c) >= 4.5);
							expect(ok || warned, `${where} #${i} subheadline`).toBe(true);
						}
					}
					checked++;
				}
			}
		}
		expect(checked).toBe(2 * fills.length * fills.length);
	});
	it('badge label ≥ 4.5 on its pill for any accent colour', () => {
		for (const accent of ['#E91E63', '#F57C00', '#FFE600', '#00C2FF', '#1E9E63', '#777777', '#6C2BC4', '#FFFFFF', '#000000']) {
			const { template } = composeSet(tonalPlan(1, { palette: { mode: 'tonal', colors: ['#FFB61E', accent] }, hero: { badge: 'Grades 1–12' } }));
			const pill = fdOf(byName(template.screens[0], 'Badge')[0]);
			const label = fdOf(byName(template.screens[0], 'Badge text')[0]);
			expect(contrastRatio(String(label.fill), String(pill.fill)), accent).toBeGreaterThanOrEqual(4.5);
		}
	});
	it('a seam mascot and the next screen\'s own mascot never overlap', () => {
		for (const anchor of ['headline', 'device-top', 'device-side'] as const) {
			const { template } = composeSet(
				tonalPlan(2, { hero: false, panorama: { spans: [[0, 1]], decoration: 'wave' } }, (i) => ({ mascot: { art: 'bee', anchor: i === 0 ? 'seam' : anchor, size: 0.3 } }))
			);
			const ms = [...byName(template.screens[1], 'Mascot'), ...byName(template.screens[1], 'Mascot (continued)')];
			for (let a = 0; a < ms.length; a++) for (let b = a + 1; b < ms.length; b++) expect(overlap(box(ms[a]), box(ms[b])), anchor).toBe(false);
		}
	});
	it('the hero never adds a headline line (even a one-liner stays one line)', () => {
		const { report } = composeSet(tonalPlan(2, {}, () => ({ headline: 'Words for every grade' })));
		expect(report.screens[0].headlineLines.length).toBe(report.screens[1].headlineLines.length);
	});
	it('variant C keeps the input hero screen: no seam mascot on the hero\'s span', () => {
		const plan = tonalPlan(6, { hero: { screen: 3 } });
		const c = makeVariants(plan)[2].plan;
		const heroSpan = c.style!.panorama!.spans!.find((sp) => sp.includes(3))!;
		expect((c.style!.hero as { screen: number }).screen).toBe(3);
		for (const i of heroSpan) expect(c.screens[i].mascot).toBeUndefined();
		expect(composeSet(c).report.screens[3].role).toBe('hero');
	});
});

describe('deviceShadow at the handoff boundary (validateTemplate)', () => {
	const withShadow = (deviceShadow: unknown) => {
		const { template } = composeSet(tonalPlan(1));
		(template.screens[0].layers.find((l) => l.type === 'device')!.fabricData as Fd).deviceShadow = deviceShadow;
		return validateTemplate(template);
	};
	it('accepts what the composer emits', () => {
		expect(validateTemplate(composeSet(tonalPlan(2)).template)).toEqual({ valid: true, errors: [] });
	});
	it.each([
		['huge blur', { color: 'rgba(0,0,0,0.3)', blur: 1e9, offsetX: 0, offsetY: 4 }],
		['negative blur', { color: 'rgba(0,0,0,0.3)', blur: -1, offsetX: 0, offsetY: 4 }],
		['NaN-ish offset', { color: 'rgba(0,0,0,0.3)', blur: 4, offsetX: 'x', offsetY: 4 }],
		['offset beyond the canvas', { color: 'rgba(0,0,0,0.3)', blur: 4, offsetX: 0, offsetY: 5000 }],
		['long colour', { color: 'x'.repeat(65), blur: 4 }],
		['extra key', { color: '#000', blur: 4, src: '/api/screenshots/a/raw' }],
		['not an object', 'shadow']
	])('rejects %s', (_, value) => {
		expect(withShadow(value).valid).toBe(false);
	});
	it('only on device layers', () => {
		const { template } = composeSet(tonalPlan(1, { presentation: 'frameless' }));
		(template.screens[0].layers.find((l) => l.type === 'image')!.fabricData as Fd).deviceShadow = { color: '#000', blur: 4 };
		expect(validateTemplate(template).errors.join()).toMatch(/only allowed on device layers/);
	});
});
