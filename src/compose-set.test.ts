import { describe, it, expect } from 'vitest';
import { composeSet, composeTemplate, COMPOSE_LAYOUTS, HEADLINE_SIZE, STRADDLE_MIN, type ComposePlan, type ComposeScreenPlan } from './compose';
import { makeVariants, panoramaPairs, VARIANT_HERO_TILT } from './variants';
import { NO_TANGENT, focusCorners, inTangentZone, rectsOverlap, rotatedBox, subjectPointToCanvas } from './layout-system';
import { getDeviceFrame, deviceFrames } from './device-frames';
import { makeSolidBackground } from './builders';
import { validateTemplate } from './validate';
import { contrastRatio, luminance, parseHex } from './color';
import type { LayerJSON, ScreenLayersJSON } from './types';

type Fd = Record<string, unknown>;
const fdOf = (l: LayerJSON) => l.fabricData as Fd;
const shot = (id: string) => ({ url: `/api/screenshots/${id}/raw`, width: 1320, height: 2868 });
const screen = (i: number, extra: Partial<ComposeScreenPlan> = {}): ComposeScreenPlan => ({
	headline: 'Hear the word. Spell it.',
	background: makeSolidBackground('#2E6FD8'),
	deviceId: 'iphone_17_pro_max',
	screenshot: shot(`s${i}`),
	...extra
});
const COPY: Array<Pick<ComposeScreenPlan, 'headline' | 'subheadline'>> = [
	{ headline: 'Spell it.' },
	{ headline: 'Hear the word. Spell it.', subheadline: 'Every word read aloud, with a big kid-sized letter pad' },
	{ headline: 'One list. Lots of games.', subheadline: '18 games' },
	{ headline: 'Watch them improve.' },
	{ headline: 'Words for their grade.', subheadline: 'Ready-made packs for 1st–12th grade' }
];
/**
 * The 0.4.0 set-system fixtures. `hero: false` (0.5.0's hero is an accent with its own type size and
 * group); the hero and the other 0.5.0 roles are covered in art-direction.test.ts.
 */
const plan = (extra: Partial<ComposePlan> = {}, screenExtra: (i: number) => Partial<ComposeScreenPlan> = () => ({})): ComposePlan => ({
	name: 'Set',
	screens: COPY.map((c, i) => screen(i, { ...c, ...screenExtra(i) })),
	...extra,
	style: { hero: false, ...extra.style }
});
const subjectLayer = (s: ScreenLayersJSON) =>
	s.layers.find((l) => l.type === 'device' && !l.name.endsWith('(continued)')) ??
	s.layers.find((l) => l.type === 'image' && !l.name.endsWith('(continued)'))!;
const byKey = (s: ScreenLayersJSON, key: string) => s.layers.find((l) => l.templateKey === key);

/** Rotated bounding box of a device/image layer, from its fabricData alone. */
function layerBox(l: LayerJSON) {
	const f = fdOf(l);
	const s = f.scaleX as number;
	const b = rotatedBox((f.width as number) * s, (f.height as number) * s, (f.angle as number) ?? 0);
	return { top: (f.top as number) - b.height / 2, bottom: (f.top as number) + b.height / 2, left: (f.left as number) - b.width / 2, right: (f.left as number) + b.width / 2, height: b.height };
}

describe('principle 1 — one system per set', () => {
	it('every text-top screen shares device scale, baseline, headline size and headline position', () => {
		const { template, report } = composeSet(plan());
		const scales = new Set(template.screens.map((s) => fdOf(subjectLayer(s)).scaleX));
		const centres = new Set(template.screens.map((s) => (fdOf(subjectLayer(s)).top as number).toFixed(9)));
		const sizes = new Set(template.screens.map((s) => fdOf(byKey(s, 'headline')!).fontSize));
		expect(scales.size).toBe(1);
		expect(centres.size).toBe(1);
		expect(sizes.size).toBe(1);
		expect([...sizes][0]).toBeCloseTo(280 * HEADLINE_SIZE, 9);
		// headline boxes are top-anchored at the same y (text area reserved for the tallest block)
		expect(new Set(report.screens.map((m) => m.headlineTop.toFixed(9))).size).toBe(1);
		expect(new Set(report.screens.map((m) => m.group)).size).toBe(1);
	});

	it('copy length never moves or resizes anything: only the tallest block matters', () => {
		const short = composeSet(plan({}, () => ({ subheadline: undefined, headline: 'Spell it.' })));
		const tallAtEnd = composeSet(
			plan({}, (i) => (i === 4 ? { subheadline: 'Every word read aloud, with a big kid-sized letter pad' } : { subheadline: undefined, headline: 'Spell it.' }))
		);
		// the tall block on screen 5 pushes EVERY device down by the same amount
		const d0 = tallAtEnd.template.screens.map((s) => fdOf(subjectLayer(s)).top);
		expect(new Set(d0).size).toBe(1);
		expect(d0[0] as number).toBeGreaterThan(fdOf(subjectLayer(short.template.screens[0])).top as number);
	});

	it('drops the per-screen long-headline shrink (same size + a lint warning)', () => {
		const { template, report } = composeSet(plan({}, (i) => (i === 0 ? { headline: '18 Fun Games That Make Spelling Stick Every Day' } : {})));
		const sizes = template.screens.map((s) => fdOf(byKey(s, 'headline')!).fontSize);
		expect(new Set(sizes).size).toBe(1);
		expect(report.warnings.map((w) => `${w.screen}:${w.code}`)).toEqual(expect.arrayContaining(['0:headline-words', '0:headline-lines']));
	});

	it('keeps separate systems per device class / layout, each internally consistent', () => {
		const mixed = composeSet({
			name: 'Mixed',
			style: { hero: false },
			screens: [
				screen(0),
				screen(1, { layout: 'device-bleed' }),
				screen(2),
				screen(3, { deviceId: 'ipad_pro_13_m4', screenshot: { url: '/api/screenshots/p/raw', width: 2064, height: 2752 } }),
				screen(4, { deviceId: 'ipad_pro_13_m4', screenshot: { url: '/api/screenshots/q/raw', width: 2064, height: 2752 } })
			]
		});
		const g = mixed.report.screens.map((m) => m.group);
		expect(g[0]).toBe(g[2]);
		expect(g[3]).toBe(g[4]);
		expect(g[1]).not.toBe(g[0]);
		expect(mixed.report.screens[3].scale).toBe(mixed.report.screens[4].scale);
		expect(validateTemplate(mixed.template).valid).toBe(true);
	});
});

describe('principle 2 — no tangents', () => {
	const devices = [
		{ deviceId: 'iphone_17_pro_max', w: 1320, h: 2868 },
		{ deviceId: 'pixel_9_pro_xl', w: 1344, h: 2992 },
		{ deviceId: 'ipad_pro_13_m4', w: 2064, h: 2752 },
		{ deviceId: 'macbook_pro_14', w: 3024, h: 1964 }
	];
	const subs = [undefined, 'One short line', 'Every word read aloud, with a big kid-sized letter pad for small hands'];
	it('never lands a subject in the "just touching" band (devices × layouts × presentations × copy × bleed)', () => {
		let checked = 0;
		for (const d of devices) {
			for (const layout of COMPOSE_LAYOUTS) {
				for (const presentation of ['device', 'frameless', 'zoom'] as const) {
					for (const bleed of ['auto', 'none', 'deep'] as const) {
						for (const sub of subs) {
							for (const tilt of [0, 8]) {
								const { template, report } = composeSet({
									name: 'P',
									style: { presentation, bleed, tilt, tiltScreens: [0] },
									screens: [
										screen(0, { deviceId: d.deviceId, layout, subheadline: sub, screenshot: { url: '/api/screenshots/a/raw', width: d.w, height: d.h } })
									]
								});
								const s = template.screens[0];
								const H = s.canvasHeight!;
								const box = layerBox(subjectLayer(s));
								const farOvershoot = layout === 'text-bottom' ? -box.top : box.bottom - H;
								const where = `${d.deviceId} ${layout} ${presentation} ${bleed} sub=${!!sub} tilt=${tilt}`;
								expect(inTangentZone(farOvershoot, box.height, H), where).toBe(false);
								expect(report.screens[0].tangent, where).toBe(false);
								expect(validateTemplate(template).errors, where).toEqual([]);
								checked++;
							}
						}
					}
				}
			}
		}
		expect(checked).toBe(4 * 3 * 3 * 3 * 3 * 2);
	});

	it('fixes a 2-line headline + 2-line subheadline that used to touch the bottom', () => {
		const { report } = composeSet({ name: 'T', screens: [screen(0, { subheadline: 'Every word read aloud, with a big kid-sized letter pad' })] });
		const m = report.screens[0];
		expect(m.tangent).toBe(false);
		expect(m.mode === 'clear' ? -m.overshoot >= NO_TANGENT.clearGap - 1e-9 : m.bleedFraction >= NO_TANGENT.minBleed - 1e-9).toBe(true);
	});
});

describe('principle 3 — content-aware crop (focus)', () => {
	it('a deep bleed never pushes a marked focus band off-canvas', () => {
		for (const focus of [
			{ top: 0.05, bottom: 0.5 },
			{ top: 0.3, bottom: 0.8 },
			{ top: 0.6, bottom: 0.97 }
		]) {
			const { template } = composeSet({ name: 'F', style: { bleed: 'deep' }, screens: [screen(0, { focus })] });
			const s = template.screens[0];
			const f = fdOf(subjectLayer(s));
			const d = getDeviceFrame('iphone_17_pro_max')!;
			const subject = { width: d.imageDimensions.width, height: d.imageDimensions.height, screen: d.screenBounds };
			const pts = focusCorners(subject, focus).map((p) =>
				subjectPointToCanvas(subject, p, { cx: f.left as number, cy: f.top as number, scale: f.scaleX as number, angle: (f.angle as number) ?? 0 })
			);
			expect(Math.max(...pts.map((p) => p.y)), JSON.stringify(focus)).toBeLessThanOrEqual(608 * (1 - NO_TANGENT.focusSafe) + 1e-6);
		}
	});

	it('the most restrictive focus in a group decides for the whole group (consistency kept)', () => {
		const { report } = composeSet({ name: 'F', style: { bleed: 'deep', hero: false }, screens: [screen(0), screen(1, { focus: { top: 0.5, bottom: 0.99 } }), screen(2)] });
		expect(new Set(report.screens.map((m) => m.scale)).size).toBe(1);
		expect(report.screens.every((m) => m.mode === 'clear')).toBe(true);
	});
});

describe('presentations — frameless + zoom', () => {
	it('frameless = the uploaded screenshot as a rounded, shadowed image layer (no device frame)', () => {
		const { template } = composeSet(plan({ style: { presentation: 'frameless' } }));
		const s = template.screens[1];
		expect(s.layers.some((l) => l.type === 'device')).toBe(false);
		const img = subjectLayer(s);
		const f = fdOf(img);
		expect(img.type).toBe('image');
		expect(f.src).toBe('/api/screenshots/s1/raw');
		expect(f).toMatchObject({ width: 1320, height: 2868, originX: 'center', originY: 'center', crossOrigin: 'anonymous' });
		const clip = f.clipPath as Fd;
		expect(clip).toMatchObject({ type: 'Rect', width: 1320, height: 2868, originX: 'center', originY: 'center' });
		// rendered corner radius == imageCornerRadius (the editor's corner control semantics)
		expect((clip.rx as number) * (f.scaleX as number)).toBeCloseTo(f.imageCornerRadius as number, 9);
		const shadow = f.shadow as Fd;
		expect(shadow.blur as number).toBeGreaterThan(0);
		expect(f.cropX).toBeUndefined();
		expect(validateTemplate(template)).toEqual({ valid: true, errors: [] });
	});

	it('frameless corner radius is device-aware: an iPad (squarer screen corners) gets a smaller radius than an iPhone', () => {
		// Fix: a flat 0.1×width radius cut into the iPad's status bar (206px on a 2064px-wide shot);
		// the ratio now follows each device's own screen-corner-radius ÷ screen-width, clamped to
		// [0.03, 0.1]. iPhone 17 Pro Max (140/1320 ≈ 0.106) is clamped back down to the same 0.1 as
		// before (phone output unchanged); iPad Pro 13 M4 (40/2064 ≈ 0.019) is clamped up to 0.03.
		const radiusRatio = (deviceId: string, w: number, h: number) => {
			const { template } = composeSet({
				name: 'D',
				style: { presentation: 'frameless', hero: false },
				screens: [screen(0, { deviceId, screenshot: { url: '/api/screenshots/x/raw', width: w, height: h } })]
			});
			const f = fdOf(subjectLayer(template.screens[0]));
			return (f.imageCornerRadius as number) / ((f.width as number) * (f.scaleX as number));
		};
		expect(radiusRatio('iphone_17_pro_max', 1320, 2868)).toBeCloseTo(0.1, 6);
		expect(radiusRatio('ipad_pro_13_m4', 2064, 2752)).toBeCloseTo(0.03, 6);
	});

	it('zoom crops (Fabric cropX/cropY/width/height) to the focus band and scales it up', () => {
		const focus = { top: 0.3, bottom: 0.55 };
		const { template, report } = composeSet({
			name: 'Z',
			style: { presentation: 'zoom', hero: false },
			screens: [screen(0, { focus }), screen(1, { crop: { x: 0.1, y: 0.6, w: 0.5, h: 0.2 } }), screen(2)]
		});
		const zs = template.screens.map((s) => fdOf(subjectLayer(s)));
		// focus band fully inside the crop window
		expect(zs[0].cropY as number).toBeLessThanOrEqual(focus.top * 2868 + 1e-6);
		expect((zs[0].cropY as number) + (zs[0].height as number)).toBeGreaterThanOrEqual(focus.bottom * 2868 - 1e-6);
		// B1 (0.5.0): a focus-derived card shows the FULL screenshot width (no words cut at the edges)…
		expect(zs[0].cropX).toBe(0);
		expect(zs[0].width).toBe(1320);
		// …while an explicit crop is magnified vs frameless (which shows 1320 px at ~73% W)
		expect(zs[1].scaleX as number).toBeGreaterThan(0.3);
		expect(zs[1].width as number).toBeCloseTo(0.5 * 1320, 6);
		// one card box for the whole group: identical rendered size + position
		const rendered = zs.map((f) => [((f.width as number) * (f.scaleX as number)).toFixed(6), ((f.height as number) * (f.scaleY as number)).toFixed(6), (f.top as number).toFixed(6)].join());
		expect(new Set(rendered).size).toBe(1);
		// crop window stays inside the image
		for (const f of zs) {
			expect(f.cropX as number).toBeGreaterThanOrEqual(0);
			expect((f.cropX as number) + (f.width as number)).toBeLessThanOrEqual(1320 + 1e-6);
			expect((f.cropY as number) + (f.height as number)).toBeLessThanOrEqual(2868 + 1e-6);
			expect((f.clipPath as Fd).width).toBe(f.width);
		}
		expect(report.screens.every((m) => m.mode === 'clear' && !m.tangent)).toBe(true);
		expect(validateTemplate(template)).toEqual({ valid: true, errors: [] });
	});

	it('warns when a focus band is too tall for the zoom card', () => {
		const { report } = composeSet({ name: 'Z', style: { presentation: 'zoom' }, screens: [screen(0, { focus: { top: 0, bottom: 1 } })] });
		expect(report.warnings.map((w) => w.code)).toContain('zoom-focus-cropped');
	});
});

describe('principle 5 — tilt is an accent', () => {
	it('tilts only tiltScreens, pairs the tilt with a decisive bleed (or a minimum-disturbance clear), and keeps the others straight', () => {
		const { template, report } = composeSet(plan({ style: { tilt: 8, tiltScreens: [0] } }));
		// Not straddling, so the tilted phone must keep 5% side margins: the tilt is kept or reduced
		// (with a warning), never dropped silently and never exceeded.
		const angle = fdOf(subjectLayer(template.screens[0])).angle as number;
		expect(angle).toBeGreaterThan(0);
		expect(angle).toBeLessThanOrEqual(8);
		if (angle < 8) expect(report.warnings.map((w) => w.code)).toContain('tilt-reduced');
		expect(fdOf(subjectLayer(template.screens[1])).angle).toBeUndefined();
		// This screen's short copy ("Spell it.") + the tilt's side-margin cap means growth can't reach
		// a decisive bleed without shifting the subject down — minimum disturbance clears it instead
		// (never a tangent, and never a bleed short of minBleed).
		expect(report.screens[0].tangent).toBe(false);
		if (report.screens[0].mode === 'bleed') {
			expect(report.screens[0].bleedFraction).toBeGreaterThanOrEqual(NO_TANGENT.minBleed - 1e-9);
		}
		expect(report.warnings.map((w) => w.code)).not.toContain('tilt-count');
		expect(validateTemplate(template).valid).toBe(true);
	});

	it('warns when more than 2 screens are tilted', () => {
		const { report } = composeSet(plan({ style: { tilt: 6, tiltScreens: [0, 1, 2] } }));
		expect(report.warnings.map((w) => w.code)).toContain('tilt-count');
	});
});

describe('palette', () => {
	it('family: screens without a background share one gradient; auto-contrast headline', () => {
		const p = plan({ style: { palette: { mode: 'family', colors: ['#FFF3B0', '#FFD166'] } } }, () => ({ background: undefined }));
		const { template } = composeSet(p);
		const bgs = new Set(template.screens.map((s) => JSON.stringify(s.background)));
		expect(bgs.size).toBe(1);
		expect(template.screens[0].background?.gradient?.colorStops.map((c) => c.color)).toEqual(['#FFF3B0', '#FFD166']);
		expect(fdOf(byKey(template.screens[0], 'headline')!).fill).toBe('#111827'); // light palette → dark text
	});

	it('sequence: screen i uses colors[i % n]; an explicit background still wins', () => {
		const p = plan({ style: { palette: { mode: 'sequence', colors: ['#2E6FD8', '#6C2BC4'] } } }, (i) => (i === 3 ? {} : { background: undefined }));
		const { template } = composeSet(p);
		const last = (i: number) => template.screens[i].background?.gradient?.colorStops.at(-1)?.color as string;
		// The palette colours, moved (darker, same hue) only as far as white text needs for WCAG AA (B2).
		const near = (a: string, b: string) => {
			const [x, y] = [parseHex(a)!, parseHex(b)!];
			return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b));
		};
		expect(near(last(0), '#2E6FD8')).toBeLessThan(40);
		expect(near(last(1), '#6C2BC4')).toBeLessThan(40);
		expect(last(2)).toBe(last(0));
		expect(luminance(last(0))).toBeLessThanOrEqual(luminance('#2E6FD8'));
		expect(template.screens[3].background).toEqual(makeSolidBackground('#2E6FD8'));
		for (const s of template.screens) expect(fdOf(byKey(s, 'headline')!).fill).toBe('#FFFFFF');
		for (const i of [0, 1, 2]) {
			for (const stop of template.screens[i].background!.gradient!.colorStops) expect(contrastRatio('#FFFFFF', stop.color)).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe('principle 6 — panorama spans', () => {
	const pano = (straddle: boolean, extra: (i: number) => Partial<ComposeScreenPlan> = () => ({})) =>
		composeSet(plan({ style: { panorama: { spans: [[0, 1], [2, 3]], straddle } } }, extra));

	it('one continuous gradient rect sized N×W, offset by −i×W on screen i of the span', () => {
		const ramp = { type: 'gradient' as const, gradient: { type: 'linear' as const, colorStops: [{ offset: 0, color: '#6FC5FF' }, { offset: 1, color: '#2E6FD8' }] } };
		const { template } = pano(false, (i) => (i === 0 || i === 2 ? { background: ramp } : {}));
		for (const [i, k] of [
			[0, 0],
			[1, 1],
			[2, 0],
			[3, 1]
		]) {
			const bg = template.screens[i].layers[0];
			const f = fdOf(bg);
			expect(bg.name).toBe(`Panorama background (${k + 1}/2)`);
			expect(f.width).toBe(560);
			expect(f.height).toBe(608);
			expect(f.left).toBe(280 - k * 280); // centre-origin: N·W/2 − k·W
			expect((f.fill as Fd).coords).toEqual({ x1: 0, y1: 0, x2: 560, y2: 608 });
		}
		// the two halves continue exactly across the seam (same gradient, shifted by W)
		expect(JSON.stringify(fdOf(template.screens[0].layers[0]).fill)).toBe(JSON.stringify(fdOf(template.screens[1].layers[0]).fill));
		// a screen outside every span is untouched
		expect(template.screens[4].layers[0].type).toBe('device');
		expect(validateTemplate(template)).toEqual({ valid: true, errors: [] });
	});

	it('an explicit span background keeps its type, colours and angle (or is rejected clearly)', () => {
		const stops = [
			{ offset: 0, color: '#FF0000' },
			{ offset: 0.3, color: '#00FF00' },
			{ offset: 1, color: '#0000FF' }
		];
		const fillOf = (bg: ComposeScreenPlan['background']) =>
			fdOf(composeSet(plan({ style: { panorama: { spans: [[0, 1]] } } }, (i) => (i === 0 ? { background: bg } : {}))).template.screens[1].layers[0]).fill;
		// solid stays solid
		expect(fillOf(makeSolidBackground('#123456'))).toBe('#123456');
		// stops (incl. offsets) kept; no angle → corner-to-corner diagonal across the span
		expect(fillOf({ type: 'gradient', gradient: { type: 'linear', colorStops: stops } })).toMatchObject({ colorStops: stops, coords: { x1: 0, y1: 0, x2: 560, y2: 608 } });
		// an angle is honoured across the whole N·W span (90° → left to right, like deserializeBackground)
		const withAngle = fillOf({ type: 'gradient', gradient: { type: 'linear', colorStops: stops, angle: 90 } }) as Fd;
		const c = withAngle.coords as { x1: number; y1: number; x2: number; y2: number };
		expect(c.x1).toBeCloseTo(560, 6);
		expect(c.x2).toBeCloseTo(0, 6);
		expect(c.y1).toBeCloseTo(304, 6);
		// v1 `colors` are converted, not dropped to grey
		expect((fillOf({ type: 'gradient', gradient: { type: 'linear', colorStops: [], colors: ['#111111', '#EEEEEE'] } }) as Fd).colorStops).toEqual([
			{ offset: 0, color: '#111111' },
			{ offset: 1, color: '#EEEEEE' }
		]);
		expect(() => fillOf({ type: 'gradient', gradient: { type: 'radial', colorStops: stops } })).toThrow(/radial gradient background can't run across screens/);
		expect(() => fillOf({ type: 'gradient', gradient: { type: 'linear', colorStops: stops, coords: { x1: 0, y1: 0, x2: 1, y2: 1 } } })).toThrow(/coords.*can't span screens/);
	});

	it('seam orbs never overlap a text block, even on a small landscape canvas', () => {
		for (const deviceId of ['macbook_pro_14', 'imac_24', 'iphone_17_pro_max']) {
			for (const layouts of [
				['text-top', 'text-top'],
				['text-top', 'text-bottom']
			] as const) {
				const { template } = composeSet({
					name: 'O',
					style: { panorama: { spans: [[0, 1]] } },
					screens: [0, 1].map((i) => screen(i, { deviceId, layout: layouts[i], headline: 'Hear the word. Spell it.', subheadline: 'Every word read aloud', badge: 'Top pick' }))
				});
				template.screens.forEach((s) => {
					const orb = s.layers.find((l) => l.name === 'Panorama orb');
					if (!orb) return;
					const f = fdOf(orb);
					const text = s.layers.filter((l) => l.type === 'text' || l.name === 'Badge').map((l) => fdOf(l));
					for (const t of text) {
						const h = (t.height as number) ?? (t.fontSize as number) * (t.lineHeight as number) * 2;
						const top = (t.top as number) - h / 2;
						const bottom = (t.top as number) + h / 2;
						const orbTop = (f.top as number) - (f.radius as number);
						const orbBottom = (f.top as number) + (f.radius as number);
						expect(orbBottom <= top || orbTop >= bottom, `${deviceId} ${layouts} orb [${orbTop},${orbBottom}] vs text [${top},${bottom}]`).toBe(true);
					}
				});
			}
		}
	});

	it('decoration orbs sit on the seam of both screens', () => {
		const { template } = pano(false);
		const orb = (i: number) => template.screens[i].layers.find((l) => l.name === 'Panorama orb')!;
		expect(fdOf(orb(0)).left).toBe(280);
		expect(fdOf(orb(1)).left).toBe(0);
	});

	it('a straddling device is emitted on BOTH screens with seam-aligned offsets', () => {
		// Tilted clockwise, the device's top-right corner crosses the seam while a low focus band stays left.
		const { template, report } = pano(true, (i) => (i === 0 ? { focus: { top: 0.55, bottom: 0.95 }, tilt: 12 } : {}));
		expect(report.warnings.filter((w) => w.screen === 0).map((w) => w.code)).not.toContain('straddle-skipped');
		expect(report.warnings.filter((w) => w.screen === 0).map((w) => w.code)).not.toContain('panorama-seam');
		const own = fdOf(subjectLayer(template.screens[0]));
		const cont = template.screens[1].layers.find((l) => l.name.endsWith('(continued)'))!;
		expect(cont.type).toBe('device');
		expect(fdOf(cont).left as number).toBeCloseTo((own.left as number) - 280, 9);
		expect(fdOf(cont).top).toBe(own.top);
		expect(fdOf(cont).deviceFrameId).not.toBe(own.deviceFrameId);
		// the continuation paints BELOW screen 2's own device
		const idx = (l: LayerJSON) => template.screens[1].layers.indexOf(l);
		expect(idx(cont)).toBeLessThan(idx(subjectLayer(template.screens[1])));
		expect((own.left as number) + layerBox(subjectLayer(template.screens[0])).right - (own.left as number)).toBeGreaterThan(280);
		expect(report.screens[0].centerX).toBeGreaterThan(0.5);
		expect(validateTemplate(template)).toEqual({ valid: true, errors: [] });
	});

	it('seam rule: the focus band stays entirely inside its screen; else the straddle is skipped', () => {
		// A band high on the screen: the (untilted) screen area would cross → skipped with a warning.
		const skipped = pano(true, (i) => (i === 0 ? { focus: { top: 0.1, bottom: 0.9 } } : {}));
		expect(skipped.report.warnings.find((w) => w.screen === 0)?.code).toBe('straddle-skipped');
		expect(skipped.report.screens[0].centerX).toBe(0.5);
		// No focus → straddles, but warns that it can't prove the seam rule.
		const unchecked = pano(true);
		expect(unchecked.report.warnings.filter((w) => w.code === 'panorama-seam').map((w) => w.screen)).toEqual([0, 2]);
	});

	it('straddle can list span-start screens; more than one crossing per set is lint-warned', () => {
		const one = composeSet(plan({ style: { panorama: { spans: [[0, 1], [2, 3]], straddle: [2] } } }));
		expect(one.report.screens.map((m) => m.centerX > 0.5)).toEqual([false, false, true, false, false]);
		expect(one.template.screens[3].layers.some((l) => l.name.endsWith('(continued)'))).toBe(true);
		expect(one.report.warnings.map((w) => w.code)).not.toContain('panorama-straddle-count');
		const two = pano(true);
		expect(two.report.warnings.filter((w) => w.code === 'panorama-straddle-count')).toHaveLength(1);
		const listed = composeSet(plan({ style: { panorama: { spans: [[0, 1], [2, 3]], straddle: [0, 2] } } }));
		expect(listed.report.warnings.map((w) => w.code)).toContain('panorama-straddle-count');
		expect(() => composeSet(plan({ style: { panorama: { spans: [[0, 1]], straddle: [1] } } }))).toThrow(/first screen of a span/);
	});

	it('the seam never crosses a headline', () => {
		const { template } = pano(true);
		for (const i of [0, 1]) {
			const s = template.screens[i];
			const h = fdOf(byKey(s, 'headline')!);
			const left = (h.left as number) - (h.width as number) / 2;
			const right = (h.left as number) + (h.width as number) / 2;
			expect(left).toBeGreaterThan(0);
			expect(right).toBeLessThan(280);
		}
	});

	it('rejects invalid spans', () => {
		expect(() => composeSet(plan({ style: { panorama: { spans: [[0, 2]] } } }))).toThrow(/adjacent/);
		expect(() => composeSet(plan({ style: { panorama: { spans: [[0, 1], [1, 2]] } } }))).toThrow(/more than one/);
		expect(() => composeSet(plan({ style: { panorama: { spans: [[4, 5]] } } }))).toThrow(/out of range/);
		expect(() =>
			composeSet({
				name: 'X',
				style: { panorama: { spans: [[0, 1]] } },
				screens: [screen(0), screen(1, { deviceId: 'ipad_pro_13_m4' })]
			})
		).toThrow(/canvas size/);
	});
});

describe('badges', () => {
	it('rounded pill + text above the headline, never colliding with text or focus; row reserved set-wide', () => {
		const focus = { top: 0, bottom: 0.3 };
		const { template, report } = composeSet(plan({}, (i) => ({ focus, ...(i === 1 ? { badge: 'Teacher-approved' } : {}) })));
		const s = template.screens[1];
		const pill = s.layers.find((l) => l.name === 'Badge')!;
		const label = byKey(s, 'badge')!;
		const pf = fdOf(pill);
		expect(pf.type).toBe('Rect');
		expect(pf.rx).toBeCloseTo((pf.height as number) / 2, 9);
		expect(fdOf(label).text).toBe('Teacher-approved');
		const pillRect = {
			left: (pf.left as number) - (pf.width as number) / 2,
			right: (pf.left as number) + (pf.width as number) / 2,
			top: (pf.top as number) - (pf.height as number) / 2,
			bottom: (pf.top as number) + (pf.height as number) / 2
		};
		const textRect = (l: LayerJSON) => {
			const f = fdOf(l);
			const lines = 2; // both wrap to 2 lines here
			const h = (f.fontSize as number) * (f.lineHeight as number) * lines;
			return { left: 0, right: 280, top: (f.top as number) - h / 2, bottom: (f.top as number) + h / 2 };
		};
		expect(rectsOverlap(pillRect, textRect(byKey(s, 'headline')!))).toBe(false);
		expect(rectsOverlap(pillRect, textRect(byKey(s, 'subheadline')!))).toBe(false);
		expect(rectsOverlap(pillRect, layerBox(subjectLayer(s)))).toBe(false);
		// the reserved row keeps every screen's headline at the same y (badge or not)
		expect(new Set(report.screens.map((m) => m.headlineTop.toFixed(9))).size).toBe(1);
		expect(report.screens[1].headlineTop * 608).toBeGreaterThan(pillRect.bottom);
		expect(validateTemplate(template)).toEqual({ valid: true, errors: [] });
	});
});

describe('principle 4 — copy lint', () => {
	it('flags long headlines, 3+ line headlines and 2+ line subheadlines — as warnings only', () => {
		const { template, report } = composeSet(
			plan({}, (i) =>
				i === 0
					? { headline: 'Practice spelling with fun daily games' }
					: i === 1
						? { headline: 'Spell it.', subheadline: 'Every word read aloud, with a big kid-sized letter pad' }
						: { headline: 'Spell it.', subheadline: undefined }
			)
		);
		const codes = report.warnings.map((w) => `${w.screen}:${w.code}`);
		expect(codes).toContain('0:headline-words');
		expect(codes).toContain('1:subheadline-lines');
		expect(codes.some((c) => c.startsWith('2:'))).toBe(false);
		expect(validateTemplate(template).valid).toBe(true);
	});
});

describe('backward compatibility', () => {
	it('a 0.3.0-era plan (no style, no new fields) composes to [device, headline, subheadline?] and validates', () => {
		const tpl = composeTemplate({ name: 'Old', screens: [screen(0, { subheadline: 'Short line' }), screen(1)] });
		expect(tpl.screens[0].layers.map((l) => l.type)).toEqual(['device', 'text', 'text']);
		expect(tpl.screens[1].layers.map((l) => l.type)).toEqual(['device', 'text']);
		expect(validateTemplate(tpl)).toEqual({ valid: true, errors: [] });
	});

	it('an empty style composes exactly like no style', () => {
		const strip = (t: unknown) => JSON.stringify(t).replace(/layer-\d+-[a-z0-9]+/g, 'ID').replace(/"createdAt":"[^"]+"/, '').replace(/"id":"ID"/g, '');
		expect(strip(composeTemplate(plan({ style: {} })))).toBe(strip(composeTemplate(plan())));
	});
});

describe('variants A/B/C (0.5.0 art directions)', () => {
	// A brand plan (honey base colour, backgrounds from the palette) — what the skill writes.
	const base = plan({ style: { palette: { mode: 'tonal', colors: ['#FFB61E'] }, hero: {} } }, (i) => ({
		background: undefined,
		layout: i === 0 ? 'device-bleed' : i === 4 ? 'text-bottom' : 'text-top',
		...(i === 2 ? { focus: { top: 0.2, bottom: 0.5 } } : {})
	}));
	const [a, b, c] = makeVariants(base);

	it('names each concept and keeps the copy', () => {
		expect([a.plan.name, b.plan.name, c.plan.name]).toEqual(['Set — A Brand Classic', 'Set — B Clean Frameless', 'Set — C Story Panorama']);
		for (const v of [a, b, c]) expect(v.plan.screens.map((s) => s.headline)).toEqual(base.screens.map((s) => s.headline));
	});

	it('keeps compatible explicit choices (bleed none, font, badges, focus, panorama spans, tilt); brand colours → tonal', () => {
		const custom: ComposePlan = {
			...base,
			style: { bleed: 'none', font: 'Georgia', palette: { mode: 'family', colors: ['#123456'] }, tilt: 6, tiltScreens: [3], presentation: 'zoom', panorama: { spans: [[1, 2]], decoration: 'none' } },
			screens: base.screens.map((s, i) => (i === 1 ? { ...s, badge: 'Top pick', presentation: 'zoom' as const, tilt: 4 } : s))
		};
		const [va, vb, vc] = makeVariants(custom);
		const tones = ['vivid', 'light', 'deep'];
		[va, vb, vc].forEach((v, k) => {
			expect(v.plan.style).toMatchObject({ bleed: 'none', font: 'Georgia', palette: { mode: 'tonal', colors: ['#123456'], tone: tones[k] } });
			expect(v.plan.screens[1].badge).toBe('Top pick');
			expect(v.plan.screens.every((s) => s.layout === 'text-top' && s.tilt === undefined)).toBe(true);
			expect(v.plan.screens[2].focus).toEqual({ top: 0.2, bottom: 0.5 });
		});
		expect(va.plan.style).not.toHaveProperty('panorama');
		expect(va.plan.style).not.toHaveProperty('tilt');
		expect(va.plan.style?.presentation).toBe('device');
		expect(vc.plan.style?.hero).toMatchObject({ tilt: 6 });
		expect(vc.plan.style?.panorama).toEqual({ spans: [[1, 2]], decoration: 'none' });
	});

	it('callouts: A and B keep an explicit choice (including "none"); default to "auto" when absent. C is always "none"', () => {
		// base has no style.callouts set → A and B default to 'auto'.
		expect(a.plan.style?.callouts).toBe('auto');
		expect(b.plan.style?.callouts).toBe('auto');
		expect(c.plan.style?.callouts).toBe('none');

		const explicitNone: ComposePlan = { ...base, style: { ...base.style, callouts: 'none' } };
		const [aNone, bNone, cNone] = makeVariants(explicitNone);
		expect(aNone.plan.style?.callouts).toBe('none');
		expect(bNone.plan.style?.callouts).toBe('none');
		expect(cNone.plan.style?.callouts).toBe('none');
	});

	it('A Brand Classic: framed, vivid tonal, hero + accent rhythm; the non-accent screens share ONE system', () => {
		const { template, report } = composeSet(a.plan);
		expect(a.plan.style).toMatchObject({ presentation: 'device', bleed: 'auto', palette: { mode: 'tonal', tone: 'vivid' }, rhythm: { every: 4, treatment: 'text-bottom' } });
		expect(report.screens.map((m) => m.role)).toEqual(['hero', 'set', 'set', 'accent', 'set']);
		expect(report.screens[3].layout).toBe('text-bottom');
		expect(new Set(report.screens.filter((m) => m.role === 'set').map((m) => m.group)).size).toBe(1);
		expect(report.screens[0].headlineSize).toBeGreaterThan(report.screens[1].headlineSize);
		expect(new Set(report.screens.map((m) => m.textColor)).size).toBe(1);
		expect(report.screens.every((m) => m.tilt === 0 && !m.tangent && m.contrast >= 4.5)).toBe(true);
		expect(validateTemplate(template).valid).toBe(true);
	});

	it('B Clean Frameless: full-width frameless screenshots (B1), light tonal, dark text', () => {
		const { template, report } = composeSet(b.plan);
		expect(report.screens.every((m) => m.presentation === 'frameless')).toBe(true);
		for (const s of template.screens) {
			const img = fdOf(subjectLayer(s));
			expect(img.cropX ?? 0).toBe(0);
			expect(img.width).toBe(1320);
		}
		expect(template.screens.flatMap((s) => s.layers).some((l) => l.type === 'device')).toBe(false);
		const text = report.screens[0].textColor;
		expect(luminance(text)).toBeLessThan(0.05);
		expect(report.screens.every((m) => m.textColor === text && m.contrast >= 4.5)).toBe(true);
		expect(validateTemplate(template).valid).toBe(true);
	});

	it('B keeps a zoom card only for an explicit crop', () => {
		const [, vb] = makeVariants({ ...base, screens: base.screens.map((s, i) => (i === 3 ? { ...s, crop: { x: 0.1, y: 0.3, w: 0.6, h: 0.2 } } : s)) });
		expect(composeSet(vb.plan).report.screens.map((m) => m.presentation)).toEqual(['frameless', 'frameless', 'frameless', 'zoom', 'frameless']);
	});

	it('C Story Panorama: triples/pairs as one scene, a motif across seams, a tilted hero, deep bleeds', () => {
		expect(panoramaPairs(base)).toEqual([
			[0, 1],
			[2, 3]
		]);
		const { template, report } = composeSet(c.plan);
		expect(c.plan.style?.panorama).toEqual({ spans: [[0, 1, 2], [3, 4]], decoration: 'wave' });
		expect(c.plan.style?.bleed).toBe('deep');
		expect(report.screens.filter((m) => m.tilt !== 0).map((m) => m.index)).toEqual([0]);
		expect(report.screens[0].tilt).toBeGreaterThan(0);
		expect(report.screens[0].tilt).toBeLessThanOrEqual(VARIANT_HERO_TILT);
		for (const [i, k, N] of [
			[0, 0, 3],
			[1, 1, 3],
			[2, 2, 3],
			[3, 0, 2],
			[4, 1, 2]
		]) {
			expect(template.screens[i].layers[0].name).toBe(`Panorama background (${k + 1}/${N})`);
			const motif = template.screens[i].layers[1];
			expect(motif.name).toBe(`Panorama motif (${k + 1}/${N})`);
			expect(fdOf(motif).type).toBe('Path');
		}
		// Each screen carries only its own part of the motif (H1; seam continuity: art-direction.test.ts).
		for (const s of template.screens) {
			const xs = (fdOf(s.layers[1]).path as Array<[string, number, number]>).filter((c) => c.length >= 3).map((c) => c[1]);
			expect(Math.min(...xs)).toBeGreaterThan(-0.3 * 280);
			expect(Math.max(...xs)).toBeLessThan(1.3 * 280);
		}
		expect(report.screens.every((m) => !m.tangent && m.contrast >= 4.5)).toBe(true);
		expect(validateTemplate(template).valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Review fixes (M1 / M2 / L7): independent geometry + contrast checks on the EMITTED layer data.
// ---------------------------------------------------------------------------

/** Independent (test-local) rotation of a point of a centre-origin w×h box. */
function toCanvas(f: Fd, w: number, h: number, px: number, py: number) {
	const s = f.scaleX as number;
	const r = (((f.angle as number) ?? 0) * Math.PI) / 180;
	const lx = (px - w / 2) * s;
	const ly = (py - h / 2) * s;
	return { x: (f.left as number) + lx * Math.cos(r) - ly * Math.sin(r), y: (f.top as number) + lx * Math.sin(r) + ly * Math.cos(r) };
}
/** Screen area (natural px) of a subject layer: the device's screen bounds, or the whole image. */
function screenArea(l: LayerJSON) {
	const f = fdOf(l);
	if (l.type === 'device') {
		const d = getDeviceFrame(f.deviceId as string)!;
		return { w: d.imageDimensions.width, h: d.imageDimensions.height, sx: d.screenBounds.x, sy: d.screenBounds.y, sw: d.screenBounds.width, sh: d.screenBounds.height };
	}
	return { w: f.width as number, h: f.height as number, sx: 0, sy: 0, sw: f.width as number, sh: f.height as number };
}
function focusPts(l: LayerJSON, focus: { top: number; bottom: number }) {
	const a = screenArea(l);
	const f = fdOf(l);
	const y0 = a.sy + focus.top * a.sh;
	const y1 = a.sy + focus.bottom * a.sh;
	return [
		[a.sx, y0],
		[a.sx + a.sw, y0],
		[a.sx + a.sw, y1],
		[a.sx, y1]
	].map(([x, y]) => toCanvas(f, a.w, a.h, x, y));
}
/** Visible horizontal extent: the rotated outline clipped to 0 ≤ y ≤ H (test-local clipping). */
function visibleX(l: LayerJSON, H: number) {
	const a = screenArea(l);
	const f = fdOf(l);
	const pts = [
		[0, 0],
		[a.w, 0],
		[a.w, a.h],
		[0, a.h]
	].map(([x, y]) => toCanvas(f, a.w, a.h, x, y));
	const xs: number[] = [];
	pts.forEach((p, i) => {
		const q = pts[(i + 1) % 4];
		if (p.y >= 0 && p.y <= H) xs.push(p.x);
		for (const yb of [0, H]) {
			if ((p.y - yb) * (q.y - yb) < 0) xs.push(p.x + ((q.x - p.x) * (yb - p.y)) / (q.y - p.y));
		}
	});
	return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
}
/** WCAG contrast, computed independently of color.ts. */
function wcag(a: string, b: string) {
	const lum = (hex: string) => {
		const n = hex.replace('#', '');
		const full = n.length === 3 ? n.replace(/./g, (c) => c + c) : n;
		const [r, g, bl] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}
/** Test-local sampling of a pixel-unit linear gradient fill at (x, y). */
function sampleFill(fill: Fd, x: number, y: number) {
	const c = fill.coords as { x1: number; y1: number; x2: number; y2: number };
	const stops = fill.colorStops as Array<{ offset: number; color: string }>;
	const dx = c.x2 - c.x1;
	const dy = c.y2 - c.y1;
	const t = Math.min(1, Math.max(0, ((x - c.x1) * dx + (y - c.y1) * dy) / (dx * dx + dy * dy)));
	const hex = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
	let a = stops[0];
	let b = stops[stops.length - 1];
	for (let i = 1; i < stops.length; i++) if (t <= stops[i].offset) {
		a = stops[i - 1];
		b = stops[i];
		break;
	}
	const u = b.offset > a.offset ? Math.min(1, Math.max(0, (t - a.offset) / (b.offset - a.offset))) : 0;
	const [ra, ga, ba] = hex(a.color);
	const [rb, gb, bb] = hex(b.color);
	return '#' + [ra + (rb - ra) * u, ga + (gb - ga) * u, ba + (bb - ba) * u].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

describe('M1 — panorama headline contrast (sampled behind the headline)', () => {
	const headlineSamples = (s: ScreenLayersJSON, k: number) => {
		const bg = fdOf(s.layers[0]);
		const h = fdOf(byKey(s, 'headline')!);
		const W = s.canvasWidth!;
		const pts: string[] = [];
		for (const fx of [0.1, 0.5, 0.9]) for (const dy of [-0.5, 0, 0.5]) pts.push(sampleFill(bg.fill as Fd, k * W + fx * W, (h.top as number) + dy * (h.fontSize as number)));
		return pts;
	};
	for (const colors of [
		['#FFF3B0', '#1E3A8A'],
		['#1E3A8A', '#FFF3B0'],
		['#FDE68A', '#FEF3C7']
	]) {
		it(`sequence ${colors.join('→')} across a pair: both headlines readable on the span background`, () => {
			const { template } = composeSet({
				name: 'P',
				style: { palette: { mode: 'sequence', colors }, panorama: { spans: [[0, 1]] } },
				screens: [screen(0, { background: undefined }), screen(1, { background: undefined })]
			});
			template.screens.forEach((s, k) => {
				const fill = fdOf(byKey(s, 'headline')!).fill as string;
				const worst = Math.min(...headlineSamples(s, k).map((c) => wcag(fill, c)));
				expect(worst, `screen ${k + 1} ${fill}`).toBeGreaterThanOrEqual(4.5);
			});
		});
	}

	it('an explicit headlineColor / subheadlineColor still wins in a span', () => {
		const { template } = composeSet({
			name: 'P',
			style: { panorama: { spans: [[0, 1]] } },
			screens: [screen(0, { background: makeSolidBackground('#FFF3B0') }), screen(1, { headlineColor: '#FF00AA', subheadline: 'Sub', subheadlineColor: '#00AAFF' })]
		});
		expect(fdOf(byKey(template.screens[1], 'headline')!).fill).toBe('#FF00AA');
		expect(fdOf(byKey(template.screens[1], 'subheadline')!).fill).toBe('#00AAFF');
		// screen 2's own (blue) background is discarded, so its auto colour follows the pale span
		const auto = composeSet({ name: 'P', style: { panorama: { spans: [[0, 1]] } }, screens: [screen(0, { background: makeSolidBackground('#FFF3B0') }), screen(1)] });
		expect(fdOf(byKey(auto.template.screens[1], 'headline')!).fill).toBe('#111827');
	});

	it('a palette with no valid hex plus a span falls back instead of crashing', () => {
		const out = composeSet({
			name: 'P',
			style: { palette: { mode: 'family', colors: ['red'] }, panorama: { spans: [[0, 1]] } },
			screens: [screen(0, { background: undefined }), screen(1, { background: undefined })]
		});
		expect(validateTemplate(out.template).valid).toBe(true);
	});
});

describe('M2 — focus + device stay inside the side margins (all edges, seams, tilts, devices)', () => {
	const devices = [
		{ deviceId: 'iphone_17_pro_max', w: 1320, h: 2868 },
		{ deviceId: 'iphone_air', w: 1260, h: 2736 },
		{ deviceId: 'pixel_9_pro_xl', w: 1344, h: 2992 },
		{ deviceId: 'ipad_pro_13_m4', w: 2064, h: 2752 },
		{ deviceId: 'macbook_pro_14', w: 3024, h: 1964 }
	];
	const focuses = [undefined, { top: 0, bottom: 1 }, { top: 0, bottom: 0.1 }, { top: 0.9, bottom: 1 }, { top: 0.3, bottom: 0.7 }];
	const copies: Array<Partial<ComposeScreenPlan>> = [
		{ headline: 'Spell it.' },
		{ headline: 'Hear the word. Spell it.', subheadline: 'Every word read aloud, with a big kid-sized letter pad' },
		{ headline: 'One list. Lots of games.', badge: 'Teacher-approved' }
	];
	it('property sweep over emitted layers (independent corner math)', () => {
		let checked = 0;
		for (const d of devices) {
			for (const canvas of d.deviceId === 'iphone_17_pro_max' ? [undefined, { canvasWidth: 1320, canvasHeight: 2868 }] : [undefined]) {
				for (const presentation of ['device', 'frameless'] as const) {
					for (const layout of COMPOSE_LAYOUTS) {
						for (const bleed of ['auto', 'none', 'deep'] as const) {
							for (const tilt of [0, 8, -12]) {
								for (const focus of focuses) {
									for (const copy of copies) {
										const { template, report } = composeSet({
											name: 'P',
											...canvas,
											style: { presentation, bleed, tilt, tiltScreens: [0] },
											screens: [screen(0, { deviceId: d.deviceId, layout, focus, ...copy, screenshot: { url: '/api/screenshots/a/raw', width: d.w, height: d.h } })]
										});
										const s = template.screens[0];
										const W = s.canvasWidth!;
										const H = s.canvasHeight!;
										const l = subjectLayer(s);
										const f = fdOf(l);
										const where = `${d.deviceId} ${W}x${H} ${presentation} ${layout} ${bleed} tilt=${tilt} f=${JSON.stringify(focus)} ${copy.headline}`;
										expect(Number.isFinite(f.scaleX as number) && (f.scaleX as number) > 0, where).toBe(true);
										expect(((f.width as number) * (f.scaleX as number)) / W, where).toBeLessThanOrEqual(NO_TANGENT.maxWidth + 1e-9);
										const vis = visibleX(l, H)!;
										expect(vis.min, `${where} left margin`).toBeGreaterThanOrEqual(NO_TANGENT.sideMargin * W - 1e-6);
										expect(vis.max, `${where} right margin`).toBeLessThanOrEqual(W - NO_TANGENT.sideMargin * W + 1e-6);
										if (focus) {
											for (const p of focusPts(l, focus)) {
												expect(p.x, `${where} focus x`).toBeGreaterThanOrEqual(NO_TANGENT.focusSideSafe * W - 1e-6);
												expect(p.x, `${where} focus x`).toBeLessThanOrEqual(W - NO_TANGENT.focusSideSafe * W + 1e-6);
												expect(p.y, `${where} focus y`).toBeGreaterThanOrEqual(NO_TANGENT.focusSafe * H - 1e-6);
												expect(p.y, `${where} focus y`).toBeLessThanOrEqual(H - NO_TANGENT.focusSafe * H + 1e-6);
											}
										}
										expect(report.screens[0].tangent, where).toBe(false);
										expect(validateTemplate(template).errors, where).toEqual([]);
										checked++;
									}
								}
							}
						}
					}
				}
			}
		}
		expect(checked).toBe(6 * 2 * 3 * 3 * 3 * 5 * 3);
	}, 30_000); // CPU-heavy sweep: ~2s alone, can exceed the 5s default under full-suite parallel load

	it('panorama straddles: focus never crosses the seam; the device crosses it decisively or not at all', () => {
		let straddled = 0;
		let skipped = 0;
		for (const d of devices.slice(0, 4)) {
			for (const tilt of [0, 8, -12]) {
				for (const focus of focuses) {
					const { template, report } = composeSet({
						name: 'P',
						style: { tilt, tiltScreens: [0], panorama: { spans: [[0, 1]], straddle: true } },
						screens: [0, 1].map((i) => screen(i, { deviceId: d.deviceId, focus, screenshot: { url: `/api/screenshots/s${i}/raw`, width: d.w, height: d.h } }))
					});
					const s = template.screens[0];
					const W = s.canvasWidth!;
					const H = s.canvasHeight!;
					const l = subjectLayer(s);
					const where = `${d.deviceId} tilt=${tilt} f=${JSON.stringify(focus)}`;
					const vis = visibleX(l, H)!;
					expect(vis.min, where).toBeGreaterThanOrEqual(NO_TANGENT.sideMargin * W - 1e-6);
					if (focus) for (const p of focusPts(l, focus)) expect(p.x, `${where} focus vs seam`).toBeLessThanOrEqual(W * (1 - NO_TANGENT.focusSideSafe) + 1e-6);
					const cont = template.screens[1].layers.find((x) => x.name.endsWith('(continued)'));
					if (cont) {
						straddled++;
						expect(vis.max, where).toBeGreaterThan(W); // crosses the seam
						// 0.5.0: decisively — at least STRADDLE_MIN of the visible device shows on the next screen
						expect(vis.max - W, `${where} straddle ≥ 18%`).toBeGreaterThanOrEqual(STRADDLE_MIN * (vis.max - vis.min) - 1e-6);
						expect(fdOf(l).left as number, where).toBeGreaterThan(W / 2); // only ever moves right
						expect(fdOf(cont).left as number).toBeCloseTo((fdOf(l).left as number) - W, 9);
					} else {
						skipped++;
						expect(vis.max, where).toBeLessThanOrEqual(W * (1 - NO_TANGENT.sideMargin) + 1e-6);
						expect(report.warnings.map((w) => w.code), where).toContain('straddle-skipped');
					}
				}
			}
		}
		expect(straddled).toBeGreaterThan(0);
		expect(skipped).toBeGreaterThan(0);
	});

	it('the review case (variant C hero, tilt 8°, focus {0.05, 0.4}) keeps the focus band on-canvas', () => {
		const base: ComposePlan = { name: 'T', screens: [0, 1, 2].map((i) => screen(i, { focus: { top: 0.05, bottom: 0.4 } })) };
		const c = makeVariants(base)[2].plan;
		const { template } = composeSet(c);
		const s = template.screens[0];
		for (const p of focusPts(subjectLayer(s), { top: 0.05, bottom: 0.4 })) {
			expect(p.x).toBeGreaterThanOrEqual(0.02 * 280 - 1e-6);
			expect(p.x).toBeLessThanOrEqual(0.98 * 280 + 1e-6);
		}
	});

	it('reduces the tilt (warning) when fitting it would shrink the device by more than 20%', () => {
		const { report } = composeSet({ name: 'T', style: { tilt: 30, tiltScreens: [0] }, screens: [screen(0, { focus: { top: 0, bottom: 1 } })] });
		expect(report.warnings.map((w) => w.code)).toContain('tilt-reduced');
		expect(Math.abs(report.screens[0].tilt)).toBeLessThan(30);
	});
});

describe('L7 — no usable room for the device', () => {
	it('throws a clear error instead of emitting a sliver (or NaN)', () => {
		const long = 'This headline is far far too long for a landscape laptop canvas and keeps going and going on '.repeat(3);
		expect(() =>
			composeSet({
				name: 'L',
				style: { bleed: 'none' },
				screens: [screen(0, { deviceId: 'macbook_pro_14', headline: long, subheadline: long + ' ' + long, screenshot: { url: '/api/screenshots/m/raw', width: 3024, height: 1964 } })]
			})
		).toThrow(/copy too long for this canvas.*cut the subheadline or headline/);
	});
});

describe('N1 — the room gate is relative to the no-copy fit (landscape devices)', () => {
	const landscape = deviceFrames.filter((d) => d.category === 'laptop' || d.category === 'desktop');
	it('covers every MacBook / iMac / display frame', () => {
		expect(landscape.length).toBeGreaterThanOrEqual(4);
		expect(landscape.map((d) => d.id)).toContain('imac_24');
	});

	it('the review repro composes: imac_24, default canvas, bleed "none", "Spell it." + "Read aloud"', () => {
		const { template, report } = composeSet({
			name: 'R',
			style: { bleed: 'none' },
			screens: [screen(0, { deviceId: 'imac_24', headline: 'Spell it.', subheadline: 'Read aloud', screenshot: { url: '/api/screenshots/i/raw', width: 4480, height: 2520 } })]
		});
		expect(validateTemplate(template).valid).toBe(true);
		expect(report.screens[0].tangent).toBe(false);
	});

	it('short copy never throws on any landscape device, bleed mode or presentation (and its variants publish)', () => {
		for (const d of landscape) {
			const shot = { url: '/api/screenshots/l/raw', width: 3024, height: 1964 };
			for (const bleed of ['auto', 'none', 'deep'] as const) {
				for (const presentation of ['device', 'frameless', 'zoom'] as const) {
					for (const copy of [{ headline: 'Spell it.' }, { headline: 'Spell it.', subheadline: 'Read aloud' }, { headline: 'Hear the word. Spell it.', subheadline: 'Every word read aloud', badge: 'Top pick' }]) {
						const where = `${d.id} ${bleed} ${presentation} ${JSON.stringify(copy)}`;
						expect(() => composeSet({ name: 'L', style: { bleed, presentation }, screens: [screen(0, { deviceId: d.id, ...copy, screenshot: shot })] }), where).not.toThrow();
					}
				}
			}
			const base: ComposePlan = { name: 'V', style: { bleed: 'none' }, screens: [0, 1, 2].map((i) => screen(i, { deviceId: d.id, headline: 'Spell it.', subheadline: 'Read aloud', screenshot: shot })) };
			for (const v of makeVariants(base)) expect(() => composeSet(v.plan), `${d.id} variant ${v.key}`).not.toThrow();
		}
	});

	it('genuinely long copy still throws — blaming the copy', () => {
		const long = 'This headline is far far too long for a landscape laptop canvas and keeps going and going on '.repeat(5);
		expect(() =>
			composeSet({ name: 'L', style: { bleed: 'none' }, screens: [screen(0, { deviceId: 'imac_24', headline: long, subheadline: long, screenshot: { url: '/api/screenshots/i/raw', width: 4480, height: 2520 } })] })
		).toThrow(/copy too long for this canvas.*room it gets with no copy.*cut the subheadline or headline/);
	});

	it('a device that can\'t fit the canvas even with no copy blames the canvas, not the copy', () => {
		const run = () => composeSet({ name: 'M', canvasWidth: 608, canvasHeight: 250, screens: [screen(0, { headline: 'Hi' })] });
		expect(run).toThrow(/device iphone_17_pro_max doesn't fit a 608×250 canvas.*even with no copy.*omit canvasWidth\/canvasHeight/);
	});
});

describe('N2 — tilted zoom cards keep their aspect and side margins', () => {
	it('property sweep: zoom at tilts 0/8/−12/15/25/30 (independent rotated-box math)', () => {
		let checked = 0;
		let reducedCount = 0;
		for (const d of [
			{ deviceId: 'iphone_17_pro_max', w: 1320, h: 2868 },
			{ deviceId: 'pixel_9_pro_xl', w: 1344, h: 2992 },
			{ deviceId: 'ipad_pro_13_m4', w: 2064, h: 2752 },
			{ deviceId: 'macbook_pro_14', w: 3024, h: 1964 }
		]) {
			for (const canvas of d.deviceId === 'iphone_17_pro_max' ? [undefined, { canvasWidth: 1320, canvasHeight: 2868 }] : [undefined]) {
				for (const layout of ['text-top', 'text-bottom'] as const) {
					for (const focus of [undefined, { top: 0.1, bottom: 0.4 }, { top: 0, bottom: 1 }]) {
						const straightAspect = (() => {
							const t = composeSet({ name: 'Z', ...canvas, style: { presentation: 'zoom' }, screens: [screen(0, { deviceId: d.deviceId, layout, focus, screenshot: { url: '/api/screenshots/z/raw', width: d.w, height: d.h } })] });
							const f = fdOf(subjectLayer(t.template.screens[0]));
							return (f.height as number) / (f.width as number);
						})();
						for (const tilt of [0, 8, -12, 15, 25, 30]) {
							const { template, report } = composeSet({
								name: 'Z',
								...canvas,
								style: { presentation: 'zoom', tilt, tiltScreens: [0] },
								screens: [screen(0, { deviceId: d.deviceId, layout, focus, screenshot: { url: '/api/screenshots/z/raw', width: d.w, height: d.h } })]
							});
							const s = template.screens[0];
							const W = s.canvasWidth!;
							const H = s.canvasHeight!;
							const f = fdOf(subjectLayer(s));
							const where = `${d.deviceId} ${W}x${H} ${layout} f=${JSON.stringify(focus)} tilt=${tilt}`;
							const angle = (f.angle as number) ?? 0;
							const r = (Math.abs(angle) * Math.PI) / 180;
							const w = (f.width as number) * (f.scaleX as number);
							const h = (f.height as number) * (f.scaleY as number);
							const boxW = w * Math.cos(r) + h * Math.sin(r);
							const boxH = w * Math.sin(r) + h * Math.cos(r);
							const left = (f.left as number) - boxW / 2;
							const top = (f.top as number) - boxH / 2;
							expect(left, `${where} left margin`).toBeGreaterThanOrEqual(0.05 * W - 1e-6);
							expect(left + boxW, `${where} right margin`).toBeLessThanOrEqual(0.95 * W + 1e-6);
							expect(top, `${where} top`).toBeGreaterThanOrEqual(-1e-6);
							expect(top + boxH, `${where} bottom`).toBeLessThanOrEqual(H + 1e-6);
							// far edge clears by the 4% margin (a zoom card never bleeds)
							if (layout === 'text-top') expect(top + boxH, where).toBeLessThanOrEqual(0.96 * H + 1e-6);
							else expect(top, where).toBeGreaterThanOrEqual(0.04 * H - 1e-6);
							expect(h / w, `${where} aspect`).toBeCloseTo(straightAspect, 6);
							expect(w / W, `${where} not a sliver`).toBeGreaterThanOrEqual(0.8 * 0.4);
							expect(Math.abs(angle), where).toBeLessThanOrEqual(Math.abs(tilt));
							if (angle !== tilt) {
								reducedCount++;
								expect(report.warnings.map((x) => x.code), where).toContain('tilt-reduced');
							}
							expect(validateTemplate(template).errors, where).toEqual([]);
							checked++;
						}
					}
				}
			}
		}
		expect(checked).toBe(5 * 2 * 3 * 6);
		expect(reducedCount).toBeGreaterThan(0);
	});
});
