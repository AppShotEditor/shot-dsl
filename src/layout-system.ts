/**
 * Set-wide layout geometry for the composer (shot-dsl 0.4.0): the no-tangent rule, focus-aware
 * bleed, rotated bounding boxes and seam checks. Pure math — no DSL objects are built here, so every
 * branch is unit-testable in isolation (see layout-system.test.ts).
 *
 * Vocabulary (all canvas units unless noted):
 * - SUBJECT: what sits under the text — a device frame PNG, or the bare screenshot (frameless).
 *   `width/height` are its natural (unscaled) pixel size; `screen` is the screenshot's area inside it.
 * - NEAR edge: the subject's edge facing the text block (top for `text-top`, bottom for `text-bottom`).
 *   FAR edge: the opposite one, which may bleed off the canvas.
 * - OVERSHOOT: how far the FAR edge passes the canvas edge (> 0 = bleeds off, < 0 = gap).
 */

/** The "pro rules" thresholds. */
export const NO_TANGENT = {
	/** A subject that stays on-canvas must clear the edge by at least this × H. */
	clearGap: 0.04,
	/** A subject that bleeds must lose at least this × its own (rotated) height. */
	minBleed: 0.12,
	/**
	 * `bleed: "deep"` target, × the subject's height. Reached by growing the subject (up to
	 * `maxWidth`·W) — never by shifting it down past a decisive (`minBleed`) overshoot, since a
	 * further down-shift would just be empty space between the text and the subject.
	 */
	deepBleed: 0.25,
	/** The focus band must end at least this × H inside the canvas edge. */
	focusSafe: 0.02,
	/** Upper bound on the subject's (unrotated) width — targets are clamped to it too, × W. */
	maxWidth: 0.9,
	/**
	 * Horizontal no-tangent rule: the subject's VISIBLE extent keeps at least this × W from each side
	 * edge (a side bleed is only allowed as a deliberate panorama straddle across a seam).
	 */
	sideMargin: 0.05,
	/** The focus band's (rotated) corners stay at least this × W inside the side edges / seams. */
	focusSideSafe: 0.02,
	/** A clear-with-margin option that shrinks the subject below this × its natural scale is rejected. */
	minClearScale: 0.6,
	/**
	 * "Minimum disturbance": when growing toward a decisive bleed is capped short and the only way to
	 * reach `minBleed` is to shift the subject down (away from the text), shrinking it to clear the
	 * edge instead is preferred whenever that clear scale is still at least this × the (grown/capped)
	 * bleed scale — shrinking by ≤ 12% to clear beats pushing the subject down and leaving a gap under
	 * the text.
	 */
	clearOverShift: 0.88,
	/** Below this × the layout's target scale the copy leaves no usable room (composeSet throws). */
	minScale: 0.5
} as const;

const EPS = 1e-6;

export type BleedPreference = 'auto' | 'none' | 'deep';

/** Fractions of the screenshot height (0 = top, 1 = bottom) that must stay visible. */
export interface FocusBand {
	top: number;
	bottom: number;
}

export interface Subject {
	width: number;
	height: number;
	/** Where the screenshot sits inside the subject (natural px). Frameless: the whole image. */
	screen: { x: number; y: number; width: number; height: number };
}

export interface Point {
	x: number;
	y: number;
}

/** Axis-aligned bounding box of a w×h rectangle rotated by `angle` degrees. */
export function rotatedBox(width: number, height: number, angle = 0): { width: number; height: number } {
	const r = (angle * Math.PI) / 180;
	const c = Math.abs(Math.cos(r));
	const s = Math.abs(Math.sin(r));
	return { width: width * c + height * s, height: width * s + height * c };
}

/**
 * Canvas position of a point given in the subject's natural px (from its top-left), for a subject
 * drawn centre-origin at (cx, cy), scaled by `scale` and rotated clockwise by `angle` (Fabric).
 */
export function subjectPointToCanvas(
	subject: Subject,
	p: Point,
	pose: { cx: number; cy: number; scale: number; angle?: number }
): Point {
	const r = ((pose.angle ?? 0) * Math.PI) / 180;
	const lx = (p.x - subject.width / 2) * pose.scale;
	const ly = (p.y - subject.height / 2) * pose.scale;
	return {
		x: pose.cx + lx * Math.cos(r) - ly * Math.sin(r),
		y: pose.cy + lx * Math.sin(r) + ly * Math.cos(r)
	};
}

/** The focus band's four corners in the subject's natural px (full screen width, band height). */
export function focusCorners(subject: Subject, focus: FocusBand): Point[] {
	const { x, y, width, height } = subject.screen;
	const top = y + focus.top * height;
	const bottom = y + focus.bottom * height;
	return [
		{ x, y: top },
		{ x: x + width, y: top },
		{ x: x + width, y: bottom },
		{ x, y: bottom }
	];
}

/**
 * How far (natural px, i.e. at scale 1) the focus band reaches from the subject's rotated-AABB NEAR
 * edge toward its FAR edge. The subject keeps its focus visible iff
 * `near + scale · focusReach ≤ H · (1 − focusSafe)`.
 */
export function focusReach(subject: Subject, focus: FocusBand, angle: number, farEdge: 'bottom' | 'top'): number {
	const box = rotatedBox(subject.width, subject.height, angle);
	// Rotate about the centre at scale 1, measure y from the AABB centre.
	const ys = focusCorners(subject, focus).map((p) => subjectPointToCanvas(subject, p, { cx: 0, cy: 0, scale: 1, angle }).y);
	return farEdge === 'bottom' ? Math.max(...ys) + box.height / 2 : box.height / 2 - Math.min(...ys);
}

/** The subject's four corners (tl, tr, br, bl) on the canvas for a pose. */
export function subjectCorners(subject: Subject, pose: { cx: number; cy: number; scale: number; angle?: number }): Point[] {
	return [
		{ x: 0, y: 0 },
		{ x: subject.width, y: 0 },
		{ x: subject.width, y: subject.height },
		{ x: 0, y: subject.height }
	].map((p) => subjectPointToCanvas(subject, p, pose));
}

/** Clip a convex polygon to the horizontal band y0 ≤ y ≤ y1 (Sutherland–Hodgman, two edges). */
export function clipPolygonToBand(points: Point[], y0: number, y1: number): Point[] {
	const clip = (pts: Point[], inside: (p: Point) => boolean, cut: (a: Point, b: Point) => Point) => {
		const out: Point[] = [];
		pts.forEach((cur, i) => {
			const prev = pts[(i + pts.length - 1) % pts.length];
			if (inside(cur)) {
				if (!inside(prev)) out.push(cut(prev, cur));
				out.push(cur);
			} else if (inside(prev)) out.push(cut(prev, cur));
		});
		return out;
	};
	const atY = (y: number) => (a: Point, b: Point): Point => ({ x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y), y });
	const top = clip(points, (p) => p.y >= y0, atY(y0));
	return top.length ? clip(top, (p) => p.y <= y1, atY(y1)) : [];
}

/** Horizontal extent of the part of the subject that is actually on the canvas (null if none). */
export function visibleXExtent(
	subject: Subject,
	pose: { cx: number; cy: number; scale: number; angle?: number },
	canvasHeight: number
): { min: number; max: number } | null {
	const poly = clipPolygonToBand(subjectCorners(subject, pose), 0, canvasHeight);
	if (poly.length === 0) return null;
	const xs = poly.map((p) => p.x);
	return { min: Math.min(...xs), max: Math.max(...xs) };
}

/** Horizontal extent of the focus band's rotated corners. */
export function focusXExtent(
	subject: Subject,
	focus: FocusBand,
	pose: { cx: number; cy: number; scale: number; angle?: number }
): { min: number; max: number } {
	const xs = focusCorners(subject, focus).map((p) => subjectPointToCanvas(subject, p, pose).x);
	return { min: Math.min(...xs), max: Math.max(...xs) };
}

/** True when a far edge overshoot is in the forbidden "just touching" band. */
export function inTangentZone(overshoot: number, subjectHeight: number, canvasHeight: number): boolean {
	return overshoot > -NO_TANGENT.clearGap * canvasHeight + EPS && overshoot < NO_TANGENT.minBleed * subjectHeight - EPS;
}

export interface VerticalInput {
	canvasWidth: number;
	canvasHeight: number;
	/** Distance from the text-side canvas edge to where the subject's near edge may start. */
	near: number;
	/** The subject's near edge can't start closer than this (hero layouts push the device lower). */
	minNear?: number;
	/** Unrotated natural width (width targets are expressed on it, so a tilt doesn't shrink the device). */
	baseWidth: number;
	/** Rotated-AABB natural height (vertical extent). */
	boxHeight: number;
	/** Target rendered width, × W. */
	targetWidth: number;
	/** The natural scale is capped so no more than this fraction of the subject is off-canvas. */
	maxBleed: number;
	/** See `focusReach`; null = no focus band marked (unconstrained). */
	focusReach: number | null;
	bleed: BleedPreference;
	/** Tilted subjects: prefers a deeper bleed, but clears rather than leave a gap under the text. */
	preferBleed?: boolean;
	/** Hard upper bound on the scale (e.g. from the horizontal rules); applied to every option. */
	scaleCap?: number;
}

export interface VerticalResult {
	scale: number;
	/** Distance from the text-side edge to the subject's near edge. */
	near: number;
	/** Far edge overshoot (> 0 bleeds off the canvas). */
	overshoot: number;
	mode: 'clear' | 'bleed';
	/** overshoot ÷ rendered subject height (negative when clear). */
	bleedFraction: number;
	/** Why this option was picked (debug/report aid). */
	reason: string;
}

/**
 * THE no-tangent solver. Given where the subject may start (below the set's reserved text area) and
 * how big it wants to be, return a placement whose far edge either clears the canvas edge by
 * ≥ `clearGap`·H or bleeds by ≥ `minBleed` of the subject's height — never in between — and never
 * pushes the focus band off-canvas. Options:
 * - CLEAR: keep the near edge, shrink until the far edge clears with the margin.
 * - BLEED: grow (up to its size cap) toward the target overshoot; only when growth alone can't get
 *   there (the size cap bites first) does the subject need to shift toward the far edge to reach a
 *   decisive (`minBleed`) overshoot. When that shift would itself stay focus-safe, "minimum
 *   disturbance" is tried first: if shrinking the (grown/capped) subject back down clears the edge
 *   with the margin and loses at most `1 − clearOverShift` of that scale, that clear placement
 *   (sitting at near0, undisturbed) is used INSTEAD of shifting it down — see
 *   `NO_TANGENT.clearOverShift`. Only when clearing would shrink it more than that (or the shift
 *   wouldn't be focus-safe in the first place, so there's no real shift to prefer clearing over) does
 *   it fall back to shifting down, and even then never further than `minBleed` needs — never all the
 *   way to a deeper target, which would otherwise leave empty space between the text and the subject.
 *   If the (shifted) result hides the focus band, the placement instead targets the smallest decisive
 *   bleed (`minBleed`) that stays focus-safe — or near0 itself, when near0 already sits further down
 *   than that — else the bleed option is unavailable.
 * `none` → always clear. `deep` → grow toward `deepBleed` (≥ `minBleed` at the width cap, ≥ `deepBleed`
 * whenever growth alone reaches it, else the minimum-disturbance clear above), or the most the focus
 * allows, else clear.
 * `auto` → keep the natural placement when it already clears by the margin or is a focus-safe
 * decisive bleed; otherwise (the tangent zone) PREFER the bleed option — or its minimum-disturbance
 * clear, when a shallow shrink beats the shift a decisive bleed would need — and fall back to clear
 * when no ≥ `minBleed` bleed keeps the focus band visible.
 * `preferBleed` (tilt) also turns a natural clear into a bleed — or its minimum-disturbance clear, when
 * the tilt's scale cap stops it from reaching a decisive bleed without a shift.
 */
export function solveVertical(inp: VerticalInput): VerticalResult {
	const W = inp.canvasWidth;
	const H = inp.canvasHeight;
	const eh = inp.boxHeight;
	const near0 = Math.max(inp.near, inp.minNear ?? 0);
	const cap = inp.scaleCap ?? Infinity;
	const sCap = Math.min((NO_TANGENT.maxWidth * W) / inp.baseWidth, cap);
	const target = Math.min(inp.targetWidth, NO_TANGENT.maxWidth);
	const s0 = Math.max(0, Math.min((target * W) / inp.baseWidth, (H - near0) / (1 - inp.maxBleed) / eh, cap));
	const focusLimit = H * (1 - NO_TANGENT.focusSafe);

	const overshoot = (s: number, a: number) => a + s * eh - H;
	const focusOk = (s: number, a: number) => inp.focusReach == null || a + s * inp.focusReach <= focusLimit + EPS;
	const make = (s: number, a: number, reason: string): VerticalResult => {
		const o = overshoot(s, a);
		return { scale: s, near: a, overshoot: o, mode: o > 0 ? 'bleed' : 'clear', bleedFraction: o / (s * eh), reason };
	};

	const clearOption = (): VerticalResult | null => {
		const s = Math.min(s0, (H * (1 - NO_TANGENT.clearGap) - near0) / eh);
		if (!(s > 0) || s < NO_TANGENT.minClearScale * s0 - EPS) return null;
		return make(s, near0, s < s0 - EPS ? 'shrunk to clear the edge with a margin' : 'clears the edge');
	};

	/**
	 * Smallest move reaching overshoot ≥ t·height, then made focus-safe (null if impossible). Growing
	 * the subject (up to its size cap — the width cap, or a tighter `scaleCap` when one binds) is
	 * always tried first. Only when that growth is capped short of t does the subject need to shift
	 * toward the far edge to reach a decisive (`minBleed`) overshoot — and even then, only when that
	 * shift would actually stay focus-safe, "minimum disturbance" is tried first: shrinking the grown
	 * subject back down to clear the edge, if that only costs ≤ `1 − clearOverShift` of its scale,
	 * beats shifting it away from the text. (When the shift itself wouldn't be focus-safe, there's no
	 * real shift to prefer clearing over, so this is skipped — the focus-constrained fallback below
	 * decides instead, exactly as it did before minimum disturbance existed.) Otherwise — clearing
	 * would shrink it more than that, or no shift is possible to compare against — it shifts down, and
	 * even then never further than `minBleed` needs, never all the way to t: a deeper target like
	 * `deepBleed` is something to grow toward, not something worth shifting the subject away from the
	 * text to force.
	 */
	const bleedOption = (t: number): VerticalResult | null => {
		let s = s0;
		let a = near0;
		if (overshoot(s, a) < t * s * eh - EPS) {
			const need = (H - a) / ((1 - t) * eh);
			s = Math.max(s0, Math.min(need, Math.max(sCap, s0)));
			if (overshoot(s, a) < NO_TANGENT.minBleed * s * eh - EPS) {
				const shifted = H - s * eh * (1 - NO_TANGENT.minBleed);
				// Minimum disturbance only competes with a shift that would actually work: if shifting
				// down to `shifted` wouldn't even keep the focus band visible, there's no real shift
				// alternative to prefer clearing over — let the focus-constrained path below (and its
				// own reasons) decide instead, same as before minimum disturbance existed.
				if (focusOk(s, shifted)) {
					// Prefer shrinking to clear (undisturbed, at near0) over shifting the subject down,
					// as long as that shrink is shallow (≤ 1 − clearOverShift of the bleed's own
					// grown/capped scale) — a small shrink beats a gap-forcing down-shift.
					const clear = clearOption();
					if (clear && clear.scale >= NO_TANGENT.clearOverShift * s - EPS) {
						const reason =
							clear.scale < s0 - EPS
								? `shrunk ${Math.round((1 - clear.scale / s0) * 100)}% to clear instead of shifting down for a bleed`
								: 'clears the edge (preferred over shifting down for a bleed)';
						return { ...clear, reason };
					}
				}
				a = shifted;
			}
		}
		const reason =
			overshoot(s, a) >= t * s * eh - EPS
				? `bleeds ${Math.round(t * 100)}%+`
				: `grows to its size cap (no gap forced to reach ${Math.round(t * 100)}%+)`;
		if (focusOk(s, a)) return make(s, a, reason);
		// Focus-constrained: keep the scale (≤ what the focus allows at near0) and bleed only as deep
		// as the focus band allows — accepted if that is still a decisive (≥ minBleed) bleed. The shift
		// itself only ever targets minBleed (never t), for the same no-gap reason as above.
		if (inp.focusReach == null) return null;
		const fr = inp.focusReach;
		const sF = Math.min(s, Math.max(sCap, s0), (focusLimit - near0) / fr);
		const denom = eh * (1 - NO_TANGENT.minBleed) - fr;
		if (!(sF > 0) || denom <= 0 || sF < (H - focusLimit) / denom - EPS) return null;
		const aF = Math.max(near0, Math.min(focusLimit - sF * fr, H - sF * eh * (1 - NO_TANGENT.minBleed)));
		if (overshoot(sF, aF) < NO_TANGENT.minBleed * sF * eh - EPS || !focusOk(sF, aF)) return null;
		return make(sF, aF, 'bleed reduced to keep the focus band visible');
	};

	/** Last resort (never a tangent): clear with the margin however small that makes the subject. */
	const forcedClear = () => make(Math.max(0, Math.min(s0, (H * (1 - NO_TANGENT.clearGap) - near0) / eh)), near0, 'forced clear');

	if (inp.bleed === 'none') return clearOption() ?? forcedClear();

	const naturalOver = overshoot(s0, near0);
	const naturalClear = naturalOver <= -NO_TANGENT.clearGap * H + EPS;
	const naturalBleed = naturalOver >= NO_TANGENT.minBleed * s0 * eh - EPS;

	if (inp.bleed === 'deep') {
		const t = Math.max(NO_TANGENT.deepBleed, naturalBleed ? naturalOver / (s0 * eh) : 0);
		return bleedOption(t) ?? clearOption() ?? forcedClear();
	}

	// auto
	if (naturalClear && !inp.preferBleed) return make(s0, near0, 'natural placement clears the edge');
	if (naturalBleed && focusOk(s0, near0)) return make(s0, near0, 'natural placement bleeds decisively');
	// In the tangent zone (or a tilted subject): resolve by bleeding decisively — or its
	// minimum-disturbance clear, when the size cap stops a decisive bleed without a shift.
	// Clear-with-margin (the naturalClear fallback below) only when no ≥ minBleed bleed keeps the
	// focus band visible.
	const bleed = bleedOption(NO_TANGENT.minBleed);
	if (bleed) return inp.preferBleed && bleed.mode === 'bleed' ? { ...bleed, reason: `${bleed.reason} (tilt pairs with a bleed)` } : bleed;
	if (naturalClear) return make(s0, near0, 'natural placement clears the edge');
	return clearOption() ?? forcedClear();
}

/** Does the vertical line x = `seamX` pass through the polygon spanned by `points`? */
export function crossesVertical(points: Point[], seamX: number, margin = 0): boolean {
	const xs = points.map((p) => p.x);
	return Math.min(...xs) < seamX + margin && Math.max(...xs) > seamX - margin;
}

/** Do two axis-aligned rects overlap? */
export function rectsOverlap(
	a: { left: number; top: number; right: number; bottom: number },
	b: { left: number; top: number; right: number; bottom: number }
): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
