import { describe, it, expect } from 'vitest';
import { canvasDimsForDevice, composeTemplate, composeSet, COMPOSE_LAYOUTS, type ComposeScreenPlan, type ComposePlan } from './compose';
import { makeVariants } from './variants';
import { NO_TANGENT } from './layout-system';
import type { ScreenLayersJSON } from './types';
import { makeSolidBackground } from './builders';
import { validateTemplate } from './validate';
import { deviceFrames } from './device-frames';

describe('composeTemplate', () => {
	it('assembles a valid Template from a plan', () => {
		const tpl = composeTemplate({
			name: 'My App',
			screens: [
				{
					headline: 'Track everything',
					background: makeSolidBackground('#0f172a'),
					deviceId: 'iphone_16_pro',
					screenshot: { url: '/api/screenshots/a/raw', width: 1179, height: 2556 }
				},
				{
					headline: 'Sync across devices',
					background: makeSolidBackground('#020617'),
					deviceId: 'iphone_16_pro',
					screenshot: { url: '/api/screenshots/b/raw', width: 1179, height: 2556 }
				}
			]
		});

		expect(tpl.screens).toHaveLength(2);
		// each screen, BOTTOM → TOP: device (carrying its screenshot) + headline — no separate
		// screenshot layer
		expect(tpl.screens[0].layers).toHaveLength(2);
		expect(tpl.screens[0].layers.map((l) => l.type)).toEqual(['device', 'text']);
		const device = tpl.screens[0].layers[0].fabricData as Record<string, unknown>;
		expect(device.screenshot).toEqual({ src: '/api/screenshots/a/raw', width: 1179, height: 2556 });
		expect(device.clipPath).toBeUndefined();
		expect(
			tpl.screens.flatMap((s) => s.layers).some((l) => (l.fabricData as Record<string, unknown>)?.layerRole === 'screenshot')
		).toBe(false);
		expect(tpl.screens[0].background?.color).toBe('#0f172a');

		const result = validateTemplate(tpl);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('centers the headline using center origin (editor convention)', () => {
		const tpl = composeTemplate({
			name: 'My App',
			canvasWidth: 280,
			screens: [
				{
					headline: 'Built by the skill',
					background: makeSolidBackground('#0f172a'),
					deviceId: 'iphone_16_pro',
					screenshot: { url: '/api/screenshots/a/raw', width: 1179, height: 2556 }
				}
			]
		});

		const headline = tpl.screens[0].layers.find((l) => l.type === 'text');
		const fd = headline?.fabricData as Record<string, unknown>;
		// left/top are the box center, so the headline can't drift off-canvas.
		expect(fd.originX).toBe('center');
		expect(fd.originY).toBe('center');
		expect(fd.left).toBe(140); // canvasWidth / 2
	});

	it('sizes each screen by its device class when no explicit canvas dims (multi-device)', () => {
		const tpl = composeTemplate({
			name: 'Mixed',
			screens: [
				{
					headline: 'iPhone',
					background: makeSolidBackground('#000'),
					deviceId: 'iphone_16_pro_max',
					screenshot: { url: '/api/screenshots/a/raw', width: 1320, height: 2868 }
				},
				{
					headline: 'iPad',
					background: makeSolidBackground('#000'),
					deviceId: 'ipad_pro_13_m4',
					screenshot: { url: '/api/screenshots/b/raw', width: 2064, height: 2752 }
				}
			]
		});

		// Phone class → 280×608 (portrait phone); tablet class → 450×600 (portrait iPad 13").
		expect(tpl.screens[0].canvasWidth).toBe(280);
		expect(tpl.screens[0].canvasHeight).toBe(608);
		expect(tpl.screens[1].canvasWidth).toBe(450);
		expect(tpl.screens[1].canvasHeight).toBe(600);
		// …and each screen is tagged with its device GROUP so the editor buckets them on import.
		expect(tpl.screens[0].deviceClass).toBe('iphone_6_9');
		expect(tpl.screens[1].deviceClass).toBe('ipad_13');
		expect(validateTemplate(tpl).valid).toBe(true);
	});

	it('tags Android + Mac device classes too', () => {
		const tpl = composeTemplate({
			name: 'AndroidMac',
			screens: [
				{
					headline: 'Android',
					background: makeSolidBackground('#000'),
					deviceId: 'pixel_9_pro',
					screenshot: { url: '/api/screenshots/a/raw', width: 1080, height: 2400 }
				},
				{
					headline: 'Mac',
					background: makeSolidBackground('#000'),
					deviceId: 'macbook_pro_14',
					screenshot: { url: '/api/screenshots/b/raw', width: 3024, height: 1964 }
				}
			]
		});
		expect(tpl.screens[0].deviceClass).toBe('android_phone');
		expect(tpl.screens[1].deviceClass).toBe('macbook');
	});

	describe('proportional layout (App Store–grade, canvas-relative)', () => {
		type Fd = Record<string, number | string>;
		const shot = { url: '/api/screenshots/a/raw', width: 1320, height: 2868 };
		const screenPlan = (extra: Partial<ComposeScreenPlan> = {}): ComposeScreenPlan => ({
			headline: 'Hear the word. Spell it.',
			subheadline: 'Short daily practice that sticks',
			background: makeSolidBackground('#123456'),
			deviceId: 'iphone_17_pro_max',
			screenshot: shot,
			...extra
		});
		const composeAt = (w: number | undefined, h: number | undefined, extra?: Partial<ComposeScreenPlan>) =>
			composeTemplate({ name: 'P', canvasWidth: w, canvasHeight: h, style: { hero: false }, screens: [screenPlan(extra)] })
				.screens[0];
		const fd = (screen: ScreenLayersJSON, key: string): Fd => {
			const layer = screen.layers.find((l) => l.templateKey === key || l.type === key);
			if (!layer) throw new Error(`no layer ${key}`);
			return layer.fabricData as Fd;
		};
		/** Normalize every geometric number of a layer to canvas units. */
		const norm = (screen: ScreenLayersJSON, key: string) => {
			const W = screen.canvasWidth!;
			const H = screen.canvasHeight!;
			const f = fd(screen, key);
			const out: Record<string, number> = {
				left: (f.left as number) / W,
				top: (f.top as number) / H
			};
			if (f.type === 'Textbox') {
				out.width = (f.width as number) / W;
				out.fontSize = (f.fontSize as number) / W;
			} else {
				out.renderedWidth = ((f.width as number) * (f.scaleX as number)) / W;
				out.renderedHeight = ((f.height as number) * (f.scaleY as number)) / H;
			}
			return out;
		};

		for (const layout of COMPOSE_LAYOUTS) {
			it(`composes proportionally identical layouts at 280×608 and 1320×2868 (${layout})`, () => {
				const small = composeAt(280, 608, { layout });
				const big = composeAt(1320, 2868, { layout });
				for (const key of ['device', 'headline', 'subheadline']) {
					const a = norm(small, key);
					const b = norm(big, key);
					for (const prop of Object.keys(a)) {
						// 280×608 vs 1320×2868 differ in aspect by ~0.06%, so allow a hair of drift.
						expect(b[prop], `${layout} ${key}.${prop}`).toBeCloseTo(a[prop], 2);
					}
				}
			});
		}

		it('the default (no override) phone path matches the native-size override proportionally', () => {
			const def = composeAt(undefined, undefined);
			expect(def.canvasWidth).toBe(280);
			const big = composeAt(1320, 2868);
			for (const key of ['device', 'headline']) {
				const a = norm(def, key);
				const b = norm(big, key);
				for (const prop of Object.keys(a)) expect(b[prop]).toBeCloseTo(a[prop], 2);
			}
		});

		for (const [w, h] of [
			[280, 608],
			[1320, 2868]
		]) {
			it(`fills the canvas at ${w}×${h}: device ≥ 75% width, headline 7–9% of width`, () => {
				for (const layout of COMPOSE_LAYOUTS) {
					const s = composeAt(w, h, { layout });
					const dev = fd(s, 'device');
					const devWidth = (dev.width as number) * (dev.scaleX as number);
					// 2-line headline + 2-line subheadline would leave a text-top device just touching the
					// bottom; the no-tangent rule resolves it (auto → a decisive bleed, ~95% width).
					expect(devWidth / w, `${layout} device width`).toBeGreaterThanOrEqual(0.75);
					expect(devWidth / w).toBeLessThanOrEqual(0.96);
					const fs = (fd(s, 'headline').fontSize as number) / w;
					expect(fs, `${layout} headline size`).toBeGreaterThanOrEqual(0.07);
					expect(fs).toBeLessThanOrEqual(0.09);
					const sub = fd(s, 'subheadline').fontSize as number;
					const ratio = sub / (fd(s, 'headline').fontSize as number);
					expect(ratio).toBeGreaterThanOrEqual(0.5);
					expect(ratio).toBeLessThanOrEqual(0.6);
				}
			});
		}

		it('never shrinks a long headline (one set-wide size; copy length is a lint warning instead)', () => {
			const s = composeAt(1320, 2868, { headline: '18 Fun Games That Make Spelling Stick Every Day' });
			const fs = (fd(s, 'headline').fontSize as number) / 1320;
			expect(fs).toBeCloseTo(0.085, 6);
		});

		it('places text and device per layout', () => {
			const H = 2868;
			const edges = (s: ScreenLayersJSON) => {
				const dev = fd(s, 'device');
				const dh = (dev.height as number) * (dev.scaleY as number);
				return { top: (dev.top as number) - dh / 2, bottom: (dev.top as number) + dh / 2 };
			};
			// text-top: headline above the device; subheadline between them.
			const top = composeAt(1320, H, { layout: 'text-top' });
			const tt = edges(top);
			expect(fd(top, 'headline').top as number).toBeLessThan(fd(top, 'subheadline').top as number);
			expect(fd(top, 'subheadline').top as number).toBeLessThan(tt.top);
			expect(tt.top).toBeGreaterThan(0);

			// text-bottom: device bleeds off the TOP, text sits below it. A longer subheadline than the
			// other layouts use here: at the default copy length, minimum disturbance (a shallow ≤12%
			// shrink clears the edge more cheaply than shifting the device off the top) now clears this
			// one instead — a legitimate outcome, just not the one this assertion is after.
			const bottom = composeAt(1320, H, { layout: 'text-bottom', subheadline: 'A much longer subheadline that takes up quite a bit more vertical room than before' });
			const tb = edges(bottom);
			expect(tb.top).toBeLessThan(0);
			expect(fd(bottom, 'headline').top as number).toBeGreaterThan(tb.bottom);
			expect(fd(bottom, 'subheadline').top as number).toBeGreaterThan(fd(bottom, 'headline').top as number);
			expect(fd(bottom, 'subheadline').top as number).toBeLessThan(H);

			// device-bleed: the hero sits lower (both are capped at 90% W), heavily off the bottom edge.
			const bleed = composeAt(1320, H, { layout: 'device-bleed' });
			const tbl = edges(bleed);
			expect(fd(bleed, 'device').scaleX as number).toBeGreaterThanOrEqual(fd(top, 'device').scaleX as number);
			expect(tbl.top).toBeGreaterThan(tt.top);
			expect(tbl.bottom - H).toBeGreaterThan(H * 0.1);
			expect(tbl.bottom).toBeGreaterThan(tt.bottom);
		});

		it('emits the subheadline as an ordinary editable text layer (a full-contrast second tier) that validates', () => {
			const tpl = composeTemplate({
				name: 'P',
				screens: [screenPlan({ headlineColor: '#111111' }), screenPlan({ subheadline: undefined })]
			});
			expect(tpl.screens[0].layers.map((l) => l.type)).toEqual(['device', 'text', 'text']);
			const sub = tpl.screens[0].layers[2];
			expect(sub.templateRole).toBe('editable');
			expect(sub.templateKey).toBe('subheadline');
			const f = sub.fabricData as Fd;
			expect(f.type).toBe('Textbox');
			// Balanced line breaks are emitted as \n; the words are the plan's.
			expect(String(f.text).replace(/\n/g, ' ')).toBe('Short daily practice that sticks');
			expect(f.fill).toBe('#111111'); // inherits headlineColor…
			expect(f.opacity).toBeUndefined(); // …at full contrast (0.5.0: no grey-on-colour)
			expect(f.fontWeight).toBe('600');
			// no subheadline → no extra layer
			expect(tpl.screens[1].layers).toHaveLength(2);
			expect(validateTemplate(tpl)).toEqual({ valid: true, errors: [] });

			const explicit = composeAt(280, 608, { subheadlineColor: '#ffcc00' });
			expect(fd(explicit, 'subheadline').fill).toBe('#ffcc00');
			expect(fd(explicit, 'subheadline').opacity).toBeUndefined();
		});

		it('keeps tablet and laptop canvases sane (device on-canvas enough, text scaled by height)', () => {
			for (const deviceId of ['ipad_pro_13_m4', 'macbook_pro_14']) {
				for (const layout of COMPOSE_LAYOUTS) {
					const s = composeTemplate({
						name: 'P',
						style: { hero: false },
						screens: [screenPlan({ deviceId, layout, screenshot: { url: '/api/screenshots/x/raw', width: 2064, height: 2752 } })]
					}).screens[0];
					const W = s.canvasWidth!;
					const H = s.canvasHeight!;
					const dev = fd(s, 'device');
					const dw = (dev.width as number) * (dev.scaleX as number);
					const dh = (dev.height as number) * (dev.scaleY as number);
					const visible = Math.min(H, (dev.top as number) + dh / 2) - Math.max(0, (dev.top as number) - dh / 2);
					expect(dw).toBeLessThanOrEqual(W);
					expect(visible / dh, `${deviceId} ${layout}`).toBeGreaterThanOrEqual(0.59);
					const fs = fd(s, 'headline').fontSize as number;
					expect(fs).toBeLessThanOrEqual(H * 0.55 * 0.09);
				}
			}
		});
	});
});

describe('deep-bleed gap regression (variants B/C, real device canvases)', () => {
	// Concepts B and C (variants.ts) force `bleed: "deep"` on every screen, including the hero. Before
	// the fix, bleedOption's down-shift targeted a 25% (deepBleed) overshoot even when growth alone
	// (capped at 90% W) couldn't get there — leaving a big empty gap between the text block and the
	// subject it was forcing to bleed. The fix caps that down-shift at a decisive (minBleed, 12%)
	// overshoot instead, growing the subject as big as the width cap allows but never shifting it past
	// what a decisive bleed needs. This suite's copy is long enough that every screen still bleeds
	// decisively here (minimum disturbance — see the short-copy suite below — only wins with a shorter,
	// shallower shrink than these configs need).
	const plan = (deviceId: string, w: number, h: number, canvasW: number, canvasH: number): ComposePlan => {
		const shot = { url: '/api/screenshots/a/raw', width: w, height: h };
		return {
			name: 'Gap regression',
			canvasWidth: canvasW,
			canvasHeight: canvasH,
			screens: [
				{
					headline: 'Track every single habit of your entire day completely',
					subheadline: 'Simple, fast, and completely private always for everyone who cares',
					background: makeSolidBackground('#123456'),
					deviceId,
					screenshot: shot
				},
				{ headline: 'Sync across every device instantly', subheadline: 'Instant, seamless, and always fully current', background: makeSolidBackground('#223456'), deviceId, screenshot: shot },
				{ headline: 'Share your progress with all your friends', subheadline: 'Invite your whole team to join today', background: makeSolidBackground('#323456'), deviceId, screenshot: shot },
				{ headline: 'Stay fully and completely in control', subheadline: 'Your data, your rules, always and forever', background: makeSolidBackground('#423456'), deviceId, screenshot: shot }
			]
		};
	};

	const cases: Array<[string, string, number, number]> = [
		['ipad_pro_13_m4', 'ipad_pro_13_m4 @ 2064×2752', 2064, 2752],
		['iphone_17_pro_max', 'iphone_17_pro_max @ 1320×2868', 1320, 2868]
	];

	for (const [deviceId, label, w, h] of cases) {
		for (const key of ['B', 'C'] as const) {
			it(`${label}, concept ${key}: every screen (incl. the hero) bleeds decisively with ≤ 6% H gap under the text`, () => {
				const p = plan(deviceId, w, h, w, h);
				const variant = makeVariants(p).find((v) => v.key === key)!;
				const { report } = composeSet(variant.plan);
				expect(report.screens.length).toBeGreaterThan(0);
				expect(report.screens.some((m) => m.role === 'hero')).toBe(true);
				for (const m of report.screens) {
					// Still a decisive, on-purpose bleed — never the forbidden "just touching" band.
					expect(m.mode, `screen ${m.index + 1} mode`).toBe('bleed');
					expect(m.tangent, `screen ${m.index + 1} tangent`).toBe(false);
					expect(m.bleedFraction, `screen ${m.index + 1} bleedFraction`).toBeGreaterThanOrEqual(NO_TANGENT.minBleed - 1e-6);
					// `top − textBottom` isn't a meaningful gap for text-bottom layouts (the text block
					// sits near the canvas bottom there, not above the subject).
					if (m.layout === 'text-bottom') continue;
					// The gap this fix closes: text block bottom → subject top.
					const gap = m.top - m.textBottom;
					expect(gap, `screen ${m.index + 1} (role ${m.role}) gap`).toBeLessThanOrEqual(0.06);
				}
			});
		}
	}

	// Short copy (e.g. a single short headline, no subheadline) leaves little text-block height to
	// close the gap with — the fix's guarantee here is structural, not a fixed ≤ 7% bound: either
	// minimum disturbance clears the subject undisturbed at near0, or it bleeds, and even then never
	// shifts down further than a decisive (minBleed) bleed needs, no matter how short the copy.
	const shortPlan = (deviceId: string, w: number, h: number): ComposePlan => {
		const shot = { url: '/api/screenshots/a/raw', width: w, height: h };
		return {
			name: 'Gap regression (short copy)',
			canvasWidth: w,
			canvasHeight: h,
			screens: [
				{ headline: 'Go further', background: makeSolidBackground('#123456'), deviceId, screenshot: shot },
				{ headline: 'Go further', background: makeSolidBackground('#223456'), deviceId, screenshot: shot }
			]
		};
	};

	for (const [deviceId, label, w, h] of cases) {
		for (const key of ['B', 'C'] as const) {
			it(`${label}, concept ${key}, short copy: clears undisturbed at near0, or bleeds with the shift ≤ what minBleed needs`, () => {
				const p = shortPlan(deviceId, w, h);
				const variant = makeVariants(p).find((v) => v.key === key)!;
				const { report } = composeSet(variant.plan);
				expect(report.screens.length).toBeGreaterThan(0);
				// Every clear-mode screen here is text-top with no minNear floor, so its gap
				// (top − textBottom) is the layout's fixed text-block ↔ subject gap — identical across
				// screens on the same canvas regardless of role. Derive the expected value from the
				// first clear screen the report itself produces, rather than hard-coding the constant.
				let clearGap: number | undefined;
				for (const m of report.screens) {
					if (m.layout === 'text-bottom') continue;
					expect(m.tangent, `screen ${m.index + 1} tangent`).toBe(false);
					const gap = m.top - m.textBottom;
					if (m.mode === 'clear') {
						clearGap ??= gap;
						// Minimum disturbance: sits at near0, so the gap matches every other clear
						// screen on this canvas exactly — no more, no less.
						expect(gap, `screen ${m.index + 1} (role ${m.role}) clear gap`).toBeCloseTo(clearGap, 5);
					} else {
						expect(m.bleedFraction, `screen ${m.index + 1} bleedFraction`).toBeGreaterThanOrEqual(NO_TANGENT.minBleed - 1e-6);
						// Pin "never shifted deeper than minBleed needs": the subject's top (÷H) is never
						// lower than the position a minBleed-only shift would put it at, i.e.
						// top ≤ H − s·eh·(1 − minBleed), expressed here in ÷H fractions (bottom − top = s·eh÷H).
						const renderedHeightFrac = m.bottom - m.top;
						const minBleedShiftTarget = 1 - renderedHeightFrac * (1 - NO_TANGENT.minBleed);
						expect(m.top, `screen ${m.index + 1} (role ${m.role}) top vs minBleed-shift target`).toBeLessThanOrEqual(minBleedShiftTarget + 1e-6);
					}
				}
			});
		}
	}
});


describe('canvasDimsForDevice', () => {
	it('keeps every existing device on its original editor dims (unchanged)', () => {
		const legacy: Record<string, { width: number; height: number }> = {
			phone: { width: 280, height: 608 },
			tablet: { width: 450, height: 600 },
			laptop: { width: 608, height: 380 },
			desktop: { width: 608, height: 380 }
		};
		const checked = deviceFrames.filter((f) => !f.id.startsWith('iphone_duo_'));
		expect(checked.length).toBeGreaterThan(20);
		for (const f of checked) expect(canvasDimsForDevice(f.id), f.id).toEqual(legacy[f.category]);
		expect(canvasDimsForDevice('iphone_17_pro_max')).toEqual({ width: 280, height: 608 });
		expect(canvasDimsForDevice('ipad_pro_13_m4')).toEqual({ width: 450, height: 600 });
		expect(canvasDimsForDevice('macbook_pro_14')).toEqual({ width: 608, height: 380 });
		expect(canvasDimsForDevice('not_a_device')).toEqual({ width: 280, height: 608 });
	});

	it('derives the iPhone Duo canvases from the frame screen aspect (608 tall)', () => {
		expect(canvasDimsForDevice('iphone_duo_inner')).toEqual({ width: 428, height: 608 });
		expect(canvasDimsForDevice('iphone_duo_outer')).toEqual({ width: 418, height: 608 });
	});

	it('composes a Duo screen at its derived canvas, tagged with its device group', () => {
		for (const [deviceId, width] of [['iphone_duo_inner', 428], ['iphone_duo_outer', 418]] as const) {
			const t = composeTemplate({
				name: 'Duo',
				screens: [{ headline: 'Hello Duo', deviceId, screenshot: { url: '/api/screenshots/a/raw', width: 1206, height: 2622 } }]
			} as unknown as ComposePlan);
			expect(t.screens[0].canvasWidth).toBe(width);
			expect(t.screens[0].canvasHeight).toBe(608);
			expect(t.screens[0].deviceClass).toBe(deviceId);
			expect(validateTemplate(t).valid).toBe(true);
		}
	});
});
