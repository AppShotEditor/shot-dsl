import { describe, it, expect } from 'vitest';
import {
	NO_TANGENT,
	crossesVertical,
	focusCorners,
	focusReach,
	inTangentZone,
	rectsOverlap,
	rotatedBox,
	solveVertical,
	subjectPointToCanvas,
	clipPolygonToBand,
	visibleXExtent,
	focusXExtent,
	type Subject,
	type VerticalInput
} from './layout-system';

// iPhone 17 Pro Max frame on the 280×608 phone canvas.
const W = 280;
const H = 608;
const PHONE: Subject = { width: 1520, height: 3068, screen: { x: 100, y: 100, width: 1320, height: 2870 } };
const base = (extra: Partial<VerticalInput> = {}): VerticalInput => ({
	canvasWidth: W,
	canvasHeight: H,
	near: 95,
	baseWidth: PHONE.width,
	boxHeight: PHONE.height,
	targetWidth: 0.86,
	maxBleed: 0.2,
	focusReach: null,
	bleed: 'auto',
	...extra
});
const renderedHeight = (s: number) => s * PHONE.height;
const naturalScale = (0.86 * W) / PHONE.width;

describe('inTangentZone (the forbidden "just touching" band)', () => {
	const dh = 500;
	it('is the open band between a 4%·H gap and a 12%·device-height bleed', () => {
		expect(inTangentZone(0, dh, H)).toBe(true);
		expect(inTangentZone(-0.039 * H, dh, H)).toBe(true);
		expect(inTangentZone(0.119 * dh, dh, H)).toBe(true);
	});
	it('accepts a real margin or a decisive bleed, boundaries included', () => {
		expect(inTangentZone(-0.04 * H, dh, H)).toBe(false);
		expect(inTangentZone(-0.2 * H, dh, H)).toBe(false);
		expect(inTangentZone(0.12 * dh, dh, H)).toBe(false);
		expect(inTangentZone(0.4 * dh, dh, H)).toBe(false);
	});
});

describe('solveVertical (no-tangent + focus-aware bleed)', () => {
	it('auto: keeps a natural placement that already clears the edge', () => {
		const r = solveVertical(base({ near: 95 }));
		expect(r.scale).toBeCloseTo(naturalScale, 9);
		expect(r.near).toBe(95);
		expect(r.mode).toBe('clear');
		expect(-r.overshoot).toBeGreaterThanOrEqual(NO_TANGENT.clearGap * H);
		expect(r.reason).toMatch(/natural/);
	});

	it('auto: keeps a natural decisive bleed (hero layout)', () => {
		const r = solveVertical(base({ near: 95, minNear: 0.28 * H, targetWidth: 0.95, maxBleed: 0.4 }));
		expect(r.near).toBeCloseTo(0.28 * H, 9);
		expect(r.mode).toBe('bleed');
		expect(r.bleedFraction).toBeGreaterThanOrEqual(NO_TANGENT.minBleed);
		expect(r.reason).toMatch(/natural/);
	});

	it('auto: minimum disturbance — in the zone, a shallow (≤12%) shrink clears instead of shifting down for a bleed', () => {
		// near 135 → natural bottom 621 (bleeds 2.7% of the device): the classic tangent. Growing to the
		// width cap still falls short of minBleed there, so a decisive bleed would need to shift the
		// subject down — but shrinking back to clear only costs ~11.8% of that grown scale, under the
		// clearOverShift (88%) threshold, so the minimum-disturbance clear wins instead of the shift.
		const natural = 135 + naturalScale * PHONE.height - H;
		expect(inTangentZone(natural, renderedHeight(naturalScale), H)).toBe(true);
		const r = solveVertical(base({ near: 135 }));
		expect(r.mode).toBe('clear');
		expect(r.near).toBe(135); // sits at near0, undisturbed
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
		expect(r.reason).toMatch(/instead of shifting down/);
	});

	it('auto: in the zone, a deep (>12%) shrink still shifts to minBleed instead of clearing', () => {
		// near 150: growing to the width cap still falls short of minBleed, and clearing here would
		// shrink by ~14.7% of the grown scale — past clearOverShift — so the shift to exactly minBleed
		// wins instead.
		const r = solveVertical(base({ near: 150 }));
		expect(r.mode).toBe('bleed');
		expect(r.near).toBeGreaterThan(150);
		expect(r.scale * PHONE.width).toBeCloseTo(NO_TANGENT.maxWidth * W, 6);
		expect(r.bleedFraction).toBeCloseTo(NO_TANGENT.minBleed, 6);
		expect(inTangentZone(r.overshoot, renderedHeight(r.scale), H)).toBe(false);
	});

	it('auto: a gap just under the 4% margin resolves with a tiny minimum-disturbance shrink', () => {
		const near = H - 0.03 * H - renderedHeight(naturalScale); // clears by only 3%·H
		const r = solveVertical(base({ near }));
		// So close to clearing already that shrinking the rest of the way is far cheaper than a shift.
		expect(r.mode).toBe('clear');
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
		expect(r.scale).toBeLessThan(naturalScale);
		expect(r.reason).toMatch(/instead of shifting down/);
	});

	it('auto: in the zone, a bleed that keeps the focus band only at a reduced depth is still a bleed', () => {
		// near 150 (not 135): a shallower near would trigger the minimum-disturbance clear before focus
		// is even considered (see the tests above) — near 150 needs the full shift to minBleed, which
		// this loose focus band (bottom 0.85) already tolerates.
		const reach = focusReach(PHONE, { top: 0.1, bottom: 0.85 }, 0, 'bottom');
		const r = solveVertical(base({ near: 150, focusReach: reach }));
		expect(r.mode).toBe('bleed');
		expect(r.near + r.scale * reach).toBeLessThanOrEqual(H * (1 - NO_TANGENT.focusSafe) + 1e-6);
	});

	it('auto: in the zone near the bleed boundary, grows into a ≥12% bleed without moving down', () => {
		// natural overshoot = 10% of the device: a small growth reaches 12%.
		const near = H + 0.1 * renderedHeight(naturalScale) - renderedHeight(naturalScale);
		const r = solveVertical(base({ near }));
		expect(r.mode).toBe('bleed');
		expect(r.bleedFraction).toBeCloseTo(NO_TANGENT.minBleed, 6);
		expect(r.near).toBeCloseTo(near, 9); // grew (width ≤ 95% W) rather than moving down
		expect(r.scale * PHONE.width).toBeLessThanOrEqual(NO_TANGENT.maxWidth * W + 1e-9);
	});

	it('deep: minimum disturbance — huge natural clearance means growing-then-shifting is skipped entirely for an undisturbed clear', () => {
		// near 60 clears by a huge margin naturally (well past clearGap). `deep` still tries to force a
		// bleed (growing to the width cap), but that only reaches a small (< minBleed) overshoot, and
		// shifting down to fix that would cost nothing relative to just clearing at near0 (0% shrink) —
		// so minimum disturbance clears instead, with no shift and no shrink at all.
		const r = solveVertical(base({ near: 60, bleed: 'deep' }));
		expect(r.mode).toBe('clear');
		expect(r.near).toBe(60); // sits at near0, undisturbed
		expect(r.scale).toBeCloseTo(naturalScale, 9); // no shrink needed either
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
		// 0% shrink (clear.scale === s0): the "clears the edge" reason, not "shrunk N%".
		expect(r.reason).toMatch(/preferred over shifting down/);
	});

	it('deep: at the width cap, a deep (>12%) shrink still shifts to exactly minBleed, never deeper', () => {
		// near 150: growing alone can't reach even 12% here (cap = 90% W), and clearing would shrink by
		// more than clearOverShift allows, so the near edge moves down too — but only far enough for
		// minBleed, not all the way to deepBleed (that would force a gap under the text for nothing).
		const r = solveVertical(base({ near: 150, bleed: 'deep' }));
		expect(r.scale * PHONE.width).toBeCloseTo(NO_TANGENT.maxWidth * W, 6);
		expect(r.mode).toBe('bleed');
		expect(r.near).toBeGreaterThan(150);
		expect(r.bleedFraction).toBeCloseTo(NO_TANGENT.minBleed, 6);
		// The old (pre-fix) behaviour would have shifted all the way to a 25% bleed — strictly further
		// down than the new minBleed-only shift.
		const s = r.scale;
		const oldNear = H - s * PHONE.height * (1 - NO_TANGENT.deepBleed);
		expect(r.near).toBeLessThan(oldNear);
	});

	it('none: always fully visible with the margin, even when the natural placement bleeds deep', () => {
		const r = solveVertical(base({ near: 0.28 * H, targetWidth: 0.95, maxBleed: 0.4, bleed: 'none' }));
		expect(r.mode).toBe('clear');
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
	});

	it('deep: keeps a deeper natural bleed as it is', () => {
		const r = solveVertical(base({ near: 0.4 * H, targetWidth: 0.95, maxBleed: 0.4, bleed: 'deep' }));
		expect(r.bleedFraction).toBeGreaterThan(NO_TANGENT.deepBleed);
	});

	it('deep: when growth alone (not capped) can\'t reach deepBleed, it still reaches it exactly — no shift needed', () => {
		// near is chosen so the grow step's target scale stays under the width cap.
		const near = 230;
		const r = solveVertical(base({ near, bleed: 'deep' }));
		expect(r.scale * PHONE.width).toBeLessThan(NO_TANGENT.maxWidth * W - 1e-6);
		expect(r.near).toBeCloseTo(near, 6); // grew only — no down-shift needed
		expect(r.bleedFraction).toBeCloseTo(NO_TANGENT.deepBleed, 6);
	});

	it('deep + focus: reduces the bleed to what keeps the focus band visible (still ≥ 12%)', () => {
		// Uncapped growth (near = 230, see above) reaches deepBleed with room to spare; a focus band
		// that would otherwise be cropped brings the bleed back down, but only enough to stay visible.
		const near = 230;
		const reach = focusReach(PHONE, { top: 0.1, bottom: 0.75 }, 0, 'bottom');
		const r = solveVertical(base({ near, bleed: 'deep', focusReach: reach }));
		expect(r.mode).toBe('bleed');
		expect(r.bleedFraction).toBeGreaterThanOrEqual(NO_TANGENT.minBleed - 1e-9);
		expect(r.bleedFraction).toBeLessThan(NO_TANGENT.deepBleed);
		expect(r.near + r.scale * reach).toBeLessThanOrEqual(H * (1 - NO_TANGENT.focusSafe) + 1e-6);
		expect(r.reason).toMatch(/focus/);
	});

	it('deep + focus reaching into the last minBleed of the subject: no decisive bleed can ever keep it visible (same in auto), so it clears instead', () => {
		// The focus band's bottom (0.9 of the screen) falls inside the last minBleed (12%) of the
		// subject's own height — the part ANY decisive bleed necessarily crops, however the subject is
		// scaled or shifted. This isn't specific to `deep` being capped at the width limit: `auto`
		// resolves the same near/focus combination the same way (a clear), and it already did before
		// this fix too — it's just the "focus too close to the bleeding edge" case.
		const reach = focusReach(PHONE, { top: 0.1, bottom: 0.9 }, 0, 'bottom');
		const r = solveVertical(base({ near: 60, bleed: 'deep', focusReach: reach }));
		expect(r.mode).toBe('clear');
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
	});

	it('deep + focus, capped at the width limit: the focus-reduced shift also targets minBleed, not the deeper target', () => {
		// near = 150 (not 60): the shrink needed to clear here is deep (> 12%), so minimum disturbance
		// doesn't intervene and growth is capped at the width limit as usual. The focus band (top 0.1,
		// bottom 0.8) crops the OLD placement: pre-fix, both the main shift and the focus-constrained
		// one (aF) targeted deepBleed, landing at near ≈ 198.6 px / bleedFraction ≈ 19.5% (aF's
		// focus-width term won out over the deepBleed target). Now that both target minBleed instead,
		// the smaller shift (near ≈ 160.4 px) already satisfies the focus band on its own — no deeper
		// gap-forcing shift is needed to "protect" a focus band that was never really threatened by a
		// merely-decisive bleed.
		const reach = focusReach(PHONE, { top: 0.1, bottom: 0.8 }, 0, 'bottom');
		const r = solveVertical(base({ near: 150, bleed: 'deep', focusReach: reach }));
		expect(r.mode).toBe('bleed');
		expect(r.bleedFraction).toBeCloseTo(NO_TANGENT.minBleed, 6);
		// The old (pre-fix) formula targeted deepBleed instead — strictly further down the canvas.
		const sF = r.scale;
		const oldNear = H - sF * PHONE.height * (1 - NO_TANGENT.deepBleed);
		expect(r.near).toBeLessThan(oldNear);
	});

	it('deep + focus at the very bottom: no bleed can keep it → clear with the margin', () => {
		const reach = focusReach(PHONE, { top: 0.5, bottom: 1 }, 0, 'bottom');
		const r = solveVertical(base({ near: 95, bleed: 'deep', focusReach: reach }));
		expect(r.mode).toBe('clear');
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
	});

	it('auto: in the zone, picks clear-with-margin ONLY when every ≥12% bleed would crop the focus band', () => {
		const near = H + 0.1 * renderedHeight(naturalScale) - renderedHeight(naturalScale); // bleed preferred…
		const reach = focusReach(PHONE, { top: 0.6, bottom: 0.98 }, 0, 'bottom'); // …but focus is at the bottom
		const r = solveVertical(base({ near, focusReach: reach }));
		expect(r.mode).toBe('clear');
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
		expect(inTangentZone(r.overshoot, renderedHeight(r.scale), H)).toBe(false);
	});

	it('auto: a natural deep bleed that crops the focus band is reduced (or cleared)', () => {
		const hero = base({ near: 95, minNear: 0.28 * H, targetWidth: 0.95, maxBleed: 0.4 });
		const reach = focusReach(PHONE, { top: 0.2, bottom: 0.8 }, 0, 'bottom');
		const r = solveVertical({ ...hero, focusReach: reach });
		expect(r.near + r.scale * reach).toBeLessThanOrEqual(H * (1 - NO_TANGENT.focusSafe) + 1e-6);
		expect(inTangentZone(r.overshoot, renderedHeight(r.scale), H)).toBe(false);
	});

	it('preferBleed (tilted subject): bleeds even when the natural placement is clear, when growth alone (uncapped) reaches minBleed', () => {
		// A small targetWidth keeps the natural scale (and so the natural placement) well clear of the
		// edge, while still leaving enough room to grow to minBleed without hitting the width cap — so
		// no shift is needed and minimum disturbance never comes into play.
		const r = solveVertical(base({ near: 250, targetWidth: 0.3, preferBleed: true }));
		expect(r.mode).toBe('bleed');
		expect(r.near).toBe(250); // grew only — no down-shift needed
		expect(r.bleedFraction).toBeCloseTo(NO_TANGENT.minBleed, 6);
		expect(r.reason).toMatch(/tilt/);
	});

	it('preferBleed + scaleCap (tilted subject capped by its margins): clears instead when the cap stops it reaching minBleed without a shift', () => {
		// A tight explicit scaleCap simulates a tilted subject whose side margins (compose.ts's
		// tilt-reduction ladder) cap its scale well below what's needed for a decisive bleed. Growth
		// hits that cap immediately, the resulting overshoot is far short of minBleed, and clearing at
		// near0 costs nothing (it's already the natural scale) — so minimum disturbance clears even
		// though `preferBleed` (the tilt) would otherwise turn a natural clear into a bleed.
		const r = solveVertical(base({ near: 95, preferBleed: true, scaleCap: 0.1 }));
		expect(r.mode).toBe('clear');
		expect(r.near).toBe(95);
		expect(r.scale).toBeCloseTo(0.1, 9);
		expect(r.overshoot).toBeLessThanOrEqual(-NO_TANGENT.clearGap * H + 1e-6);
		expect(inTangentZone(r.overshoot, renderedHeight(r.scale), H)).toBe(false);
	});

	it('a small, height-capped subject in the zone (clear would shrink it below 60%) bleeds', () => {
		const r = solveVertical(base({ near: 550, maxBleed: 0.05 }));
		expect(r.mode).toBe('bleed');
		expect(r.bleedFraction).toBeGreaterThanOrEqual(NO_TANGENT.minBleed - 1e-9);
	});

	it('property: never emits a tangent, never hides a marked focus band, and never shifts past minimum disturbance', () => {
		let cases = 0;
		const focusOkAt = (a: number, s: number, reach: number | null) => reach == null || a + s * reach <= H * (1 - NO_TANGENT.focusSafe) + 1e-6;
		for (const bleed of ['auto', 'none', 'deep'] as const) {
			for (let near = 30; near <= 330; near += 7) {
				for (const targetWidth of [0.7, 0.86, 0.95]) {
					for (const maxBleed of [0.05, 0.2, 0.4]) {
						for (const focus of [null, { top: 0, bottom: 0.4 }, { top: 0.3, bottom: 0.75 }, { top: 0.5, bottom: 1 }]) {
							for (const preferBleed of [false, true]) {
								const reach = focus ? focusReach(PHONE, focus, 0, 'bottom') : null;
								const r = solveVertical(base({ near, targetWidth, maxBleed, bleed, focusReach: reach, preferBleed }));
								const where = `${bleed} near=${near} w=${targetWidth} mb=${maxBleed} f=${JSON.stringify(focus)} pb=${preferBleed}`;
								expect(inTangentZone(r.overshoot, renderedHeight(r.scale), H), where).toBe(false);
								if (reach != null) {
									expect(r.near + r.scale * reach, where).toBeLessThanOrEqual(H * (1 - NO_TANGENT.focusSafe) + 1e-6);
								}
								if (bleed === 'none') expect(r.mode, where).toBe('clear');

								// Geometry check (not the reason string): wherever a shift down would have been
								// needed to reach a decisive bleed, and that shift would itself have stayed
								// focus-safe (a real alternative to compare against — see layout-system.ts's
								// bleedOption), a `clear` result must be minimum disturbance's clear: sitting at
								// near0, with scale ≥ clearOverShift × the grown/capped scale.
								if (bleed === 'auto' || bleed === 'deep') {
									const sCap = (NO_TANGENT.maxWidth * W) / PHONE.width;
									const s0 = Math.max(0, Math.min((Math.min(targetWidth, NO_TANGENT.maxWidth) * W) / PHONE.width, (H - near) / (1 - maxBleed) / PHONE.height));
									const naturalOver = near + s0 * PHONE.height - H;
									const naturalClear = naturalOver <= -NO_TANGENT.clearGap * H + 1e-6;
									const naturalBleed = naturalOver >= NO_TANGENT.minBleed * s0 * PHONE.height - 1e-6;
									// t: the target overshoot bleedOption is called with in this scenario, or null
									// if this mode never calls it (the natural placement already resolves it).
									const t =
										bleed === 'deep'
											? Math.max(NO_TANGENT.deepBleed, naturalBleed ? naturalOver / (s0 * PHONE.height) : 0)
											: !(naturalClear && !preferBleed) && !(naturalBleed && focusOkAt(near, s0, reach))
												? NO_TANGENT.minBleed
												: null;
									if (t != null && naturalOver < t * s0 * PHONE.height - 1e-6) {
										const need = (H - near) / ((1 - t) * PHONE.height);
										const grown = Math.max(s0, Math.min(need, Math.max(sCap, s0)));
										const overGrown = near + grown * PHONE.height - H;
										const shiftNeeded = overGrown < NO_TANGENT.minBleed * grown * PHONE.height - 1e-6;
										if (shiftNeeded) {
											const shifted = H - grown * PHONE.height * (1 - NO_TANGENT.minBleed);
											if (focusOkAt(shifted, grown, reach) && r.mode === 'clear') {
												expect(r.near, where).toBeCloseTo(near, 6);
												expect(r.scale, where).toBeGreaterThanOrEqual(NO_TANGENT.clearOverShift * grown - 1e-6);
											}
										}
									}
								}
								cases++;
							}
						}
					}
				}
			}
		}
		expect(cases).toBeGreaterThan(3000);
	});
});

describe('rotation + focus geometry', () => {
	it('rotatedBox is the identity at 0° and swaps at 90°', () => {
		expect(rotatedBox(10, 20, 0)).toEqual({ width: 10, height: 20 });
		const r = rotatedBox(10, 20, 90);
		expect(r.width).toBeCloseTo(20);
		expect(r.height).toBeCloseTo(10);
		const t = rotatedBox(1520, 3068, 8);
		expect(t.height).toBeCloseTo(1520 * Math.sin((8 * Math.PI) / 180) + 3068 * Math.cos((8 * Math.PI) / 180), 6);
	});

	it('focusReach at 0° is the band end measured from the device edge', () => {
		const f = { top: 0.2, bottom: 0.6 };
		expect(focusReach(PHONE, f, 0, 'bottom')).toBeCloseTo(100 + 0.6 * 2870, 6);
		expect(focusReach(PHONE, f, 0, 'top')).toBeCloseTo(3068 - (100 + 0.2 * 2870), 6);
	});

	it('focusReach under tilt matches the rotated corners measured from the rotated box', () => {
		const f = { top: 0.1, bottom: 0.5 };
		const angle = 10;
		const pts = focusCorners(PHONE, f).map((p) => subjectPointToCanvas(PHONE, p, { cx: 0, cy: 0, scale: 1, angle }));
		const box = rotatedBox(PHONE.width, PHONE.height, angle);
		expect(focusReach(PHONE, f, angle, 'bottom')).toBeCloseTo(Math.max(...pts.map((p) => p.y)) + box.height / 2, 6);
		// Tilting clockwise lowers the band's right end, so it reaches further than the straight band.
		expect(focusReach(PHONE, f, angle, 'bottom') - box.height / 2).toBeGreaterThan(focusReach(PHONE, f, 0, 'bottom') - PHONE.height / 2);
	});

	it('subjectPointToCanvas maps the centre to the pose centre and rotates clockwise', () => {
		const c = subjectPointToCanvas(PHONE, { x: 760, y: 1534 }, { cx: 50, cy: 60, scale: 0.1, angle: 33 });
		expect(c.x).toBeCloseTo(50);
		expect(c.y).toBeCloseTo(60);
		const right = subjectPointToCanvas(PHONE, { x: 1520, y: 1534 }, { cx: 0, cy: 0, scale: 1, angle: 90 });
		expect(right.x).toBeCloseTo(0);
		expect(right.y).toBeCloseTo(760); // the right edge swings DOWN under a clockwise turn
	});

	it('crossesVertical / rectsOverlap', () => {
		const sq = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 }
		];
		expect(crossesVertical(sq, 5)).toBe(true);
		expect(crossesVertical(sq, 12)).toBe(false);
		expect(crossesVertical(sq, 11, 2)).toBe(true);
		expect(rectsOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(true);
		expect(rectsOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 15, bottom: 10 })).toBe(false);
	});
});

describe('scale cap + horizontal helpers (M2)', () => {
	it('scaleCap bounds every option and the result is still never a tangent', () => {
		for (const bleed of ['auto', 'none', 'deep'] as const) {
			for (const near of [60, 135, 200]) {
				const cap = 0.12;
				const r = solveVertical(base({ near, bleed, scaleCap: cap }));
				expect(r.scale, `${bleed} ${near}`).toBeLessThanOrEqual(cap + 1e-12);
				expect(inTangentZone(r.overshoot, renderedHeight(r.scale), H), `${bleed} ${near}`).toBe(false);
			}
		}
	});

	it('targets above the 90% cap are clamped (5% side margin)', () => {
		const r = solveVertical(base({ near: 0.28 * H, targetWidth: 0.95, maxBleed: 0.4 }));
		expect(r.scale * PHONE.width).toBeLessThanOrEqual(0.9 * W + 1e-9);
	});

	it('clipPolygonToBand / visibleXExtent only count the on-canvas part of a tilted subject', () => {
		const sq = [
			{ x: 0, y: -10 },
			{ x: 10, y: -10 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 }
		];
		const clipped = clipPolygonToBand(sq, 0, 5);
		expect(Math.min(...clipped.map((p) => p.y))).toBe(0);
		expect(Math.max(...clipped.map((p) => p.y))).toBe(5);
		// A phone tilted 12° and pushed far below the canvas: its swung-out lower corner is off-canvas.
		const pose = { cx: 140, cy: 700, scale: 0.15, angle: 12 };
		const vis = visibleXExtent(PHONE, pose, H)!;
		const all = rotatedBox(PHONE.width * 0.15, PHONE.height * 0.15, 12);
		expect(vis.max - vis.min).toBeLessThan(all.width);
		expect(visibleXExtent(PHONE, { cx: 140, cy: 5000, scale: 0.15 }, H)).toBeNull();
		const f = focusXExtent(PHONE, { top: 0, bottom: 1 }, { cx: 140, cy: 300, scale: 0.1 });
		expect(f.min).toBeCloseTo(140 - 66, 6);
		expect(f.max).toBeCloseTo(140 + 66, 6);
	});
});
