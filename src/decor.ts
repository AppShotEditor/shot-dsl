/**
 * Decoration geometry for the composer (shot-dsl 0.5.0): panorama motifs (one Fabric `Path` that
 * runs across a whole span, offset per screen like the span background) and the rectangle tests the
 * callout / mascot placement uses. Pure math + plain JSON; no DSL layers are validated here.
 */

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export const rectOf = (cx: number, cy: number, w: number, h: number): Rect => ({ left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2 });

export const overlaps = (a: Rect, b: Rect, pad = 0): boolean =>
	a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;

export const insideRect = (inner: Rect, outer: Rect, eps = 1e-6): boolean =>
	inner.left >= outer.left - eps && inner.right <= outer.right + eps && inner.top >= outer.top - eps && inner.bottom <= outer.bottom + eps;

const area = (r: Rect) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
const intersect = (a: Rect, b: Rect): Rect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

/**
 * Share (0–1) of the focus band `focus` that `card` hides, NOT counting the part of the band the card
 * magnifies itself (`source`): (card ∩ focus − card ∩ focus ∩ source) ÷ (focus − focus ∩ source).
 */
export function focusCoverage(card: Rect, focus: Rect, source: Rect): number {
	const fs = intersect(focus, source);
	const rest = area(focus) - area(fs);
	if (rest <= 1e-9) return 0;
	const cf = intersect(card, focus);
	return Math.max(0, area(cf) - area(intersect(cf, source))) / rest;
}

export type PathCommand = [string, ...number[]];

export type Motif = 'orbs' | 'none' | 'honeycomb' | 'wave';
export const MOTIFS: readonly Motif[] = ['orbs', 'none', 'honeycomb', 'wave'];

/**
 * A motif across a span `spanWidth` × H, as SUBPATHS (each a list of path commands) in SPAN
 * coordinates, deterministic.
 * - `honeycomb`: hexagon outlines along a gentle sine band that crosses every seam.
 * - `wave`: three flowing parallel curves across the whole span.
 */
export function motifSubpaths(motif: Motif, spanWidth: number, W: number, H: number): PathCommand[][] {
	const subpaths: PathCommand[][] = [];
	if (motif === 'honeycomb') {
		const r = 0.085 * W; // hexagon circumradius
		const dx = Math.sqrt(3) * r;
		const dy = 1.5 * r;
		const centre = (x: number) => H * 0.62 + H * 0.12 * Math.sin((2 * Math.PI * x) / (1.6 * W) + 0.6);
		for (let row = -6; row <= 6; row++) {
			const y = H * 0.62 + row * dy;
			for (let col = -1; col * dx <= spanWidth + dx; col++) {
				const x = col * dx + (row % 2 ? dx / 2 : 0);
				// Keep a band ~2.6 cells tall around the sine centre line, thinning at its edges.
				const d = Math.abs(y - centre(x)) / dy;
				if (d > 1.3) continue;
				const rr = d > 0.8 ? r * 0.62 : r * 0.9;
				const hex: PathCommand[] = [];
				for (let k = 0; k < 6; k++) {
					const a = (Math.PI / 3) * k + Math.PI / 6;
					hex.push([k === 0 ? 'M' : 'L', x + rr * Math.cos(a), y + rr * Math.sin(a)]);
				}
				hex.push(['Z']);
				subpaths.push(hex);
			}
		}
	} else if (motif === 'wave') {
		const steps = Math.max(24, Math.ceil(spanWidth / (0.04 * W)));
		for (const [k, base] of [0.5, 0.58, 0.66].entries()) {
			const line: PathCommand[] = [];
			for (let i = 0; i <= steps; i++) {
				const x = (i / steps) * spanWidth;
				const y = H * base + H * 0.06 * Math.sin((2 * Math.PI * x) / (1.4 * W) + k * 0.7);
				line.push([i === 0 ? 'M' : 'L', x, y]);
			}
			subpaths.push(line);
		}
	}
	return subpaths;
}

/** Path coordinate precision (canvas units): 0.1 keeps seams exact to well under a device pixel. */
const MOTIF_PRECISION = 10;
const round1 = (v: number) => Math.round(v * MOTIF_PRECISION) / MOTIF_PRECISION;

/**
 * The part of a span-wide motif that span screen `k` shows, in THAT screen's coordinates: only the
 * subpaths (hexagons) touching [−pad, W + pad], and for open polylines only the segments that do
 * (plus the segment crossing each window edge, so strokes run continuously over the seam).
 * Coordinates are rounded to 0.1 unit. Both neighbours emit the geometry around their shared seam
 * from the same span-space points (rounded after the same −k·W shift of an integer-width offset),
 * so the halves meet exactly. Returns the commands and their bounding box (Fabric positions a Path
 * by its bbox centre), or null when nothing is visible.
 */
export function motifPathForScreen(subpaths: PathCommand[][], k: number, W: number, pad: number): { path: PathCommand[]; bbox: Rect } | null {
	const lo = k * W - pad;
	const hi = (k + 1) * W + pad;
	const out: PathCommand[] = [];
	for (const sub of subpaths) {
		const pts = sub.filter((c) => c.length >= 3) as Array<[string, number, number]>;
		if (!pts.length) continue;
		const closed = sub.some((c) => c[0] === 'Z');
		if (closed) {
			const xs = pts.map((c) => c[1]);
			if (Math.max(...xs) < lo || Math.min(...xs) > hi) continue;
			sub.forEach((c) => out.push(c.length >= 3 ? [c[0], round1((c[1] as number) - k * W), round1(c[2] as number)] : [c[0]]));
			continue;
		}
		// Open polyline: keep point i when it or a neighbour lies inside the window.
		const inside = pts.map((c) => c[1] >= lo && c[1] <= hi);
		let pen = false;
		pts.forEach((c, i) => {
			const keep = inside[i] || (i > 0 && inside[i - 1]) || (i < pts.length - 1 && inside[i + 1]);
			if (!keep) {
				pen = false;
				return;
			}
			out.push([pen ? 'L' : 'M', round1(c[1] - k * W), round1(c[2])]);
			pen = true;
		});
	}
	const xs: number[] = [];
	const ys: number[] = [];
	for (const c of out) {
		if (c.length >= 3) {
			xs.push(c[1] as number);
			ys.push(c[2] as number);
		}
	}
	if (!xs.length) return null;
	return { path: out, bbox: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } };
}
