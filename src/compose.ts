import type { BackgroundJSON, ColorStop, LayerJSON, Template } from './types';
import { makeTextLayer, makeShapeLayer, makeScreen, makeTemplate } from './builders';
import { makeDeviceFrameLayer } from './frames';
import { getDeviceFrame, deviceClassForDeviceId } from './device-frames';
import { generateLayerId, isUploadedScreenshotSrc } from './validate';
import {
	NO_TANGENT,
	focusCorners,
	focusReach,
	focusXExtent,
	inTangentZone,
	rectsOverlap,
	rotatedBox,
	solveVertical,
	subjectPointToCanvas,
	visibleXExtent,
	type BleedPreference,
	type FocusBand,
	type Subject,
	type VerticalResult
} from './layout-system';
import { contrastRatio, darken, isHexColor, lighten, mixHex, rgba } from './color';
import { breakLines, hasOrphan, isWideChar, overlongWords } from './typography';
import {
	MIN_CONTRAST,
	harmonize,
	hexToHsl,
	hslToHex,
	shiftBackground,
	textCandidates,
	tonalBackground,
	worstContrast,
	type PaletteTone
} from './palette';
import { MOTIFS, focusCoverage, insideRect, motifPathForScreen, motifSubpaths, overlaps, rectOf, type Motif, type PathCommand, type Rect } from './decor';

/** Long side of a derived editor canvas (matches the phone presets' 608). */
const DERIVED_CANVAS_LONG_SIDE = 608;

/**
 * Editor-unit canvas dimensions for a device, so a plan that mixes iPhone, iPad, Android and Mac
 * screens gets the right aspect per screen (multi-device). Export scales these up to the real store
 * pixel sizes.
 *
 * - A frame with an explicit `deviceClass` (the iPhone Duo displays, and any frame added from now
 *   on that sets one) gets its canvas DERIVED from its screen aspect: long side 608, the short side
 *   rounded (inner Duo 428×608, outer Duo 418×608). A new device then needs no change here.
 * - Every other frame keeps the original per-category table, unchanged, so saved and composed
 *   projects keep their dims: phone 280×608, tablet 450×600, laptop/desktop 608×380 (the app's
 *   Page Setup presets).
 */
export function canvasDimsForDevice(deviceId: string): { width: number; height: number } {
	const frame = getDeviceFrame(deviceId);
	if (frame?.deviceClass) {
		const { width: sw, height: sh } = frame.screenBounds;
		const L = DERIVED_CANVAS_LONG_SIDE;
		return sh >= sw
			? { width: Math.round((L * sw) / sh), height: L }
			: { width: L, height: Math.round((L * sh) / sw) };
	}
	switch (frame?.category) {
		case 'tablet':
			return { width: 450, height: 600 };
		case 'laptop':
		case 'desktop':
			return { width: 608, height: 380 };
		case 'phone':
		default:
			return { width: 280, height: 608 };
	}
}

/**
 * Screen layout variants:
 * - `text-top` (default): headline (+ subheadline) at the top, device below.
 * - `text-bottom`: device at the top (bleeding off the TOP edge when it bleeds), text block at the bottom.
 * - `device-bleed`: text at the top, the device (≤ 90% of the width) pushed low and bleeding more — the "hero" look.
 */
export type ComposeLayout = 'text-top' | 'text-bottom' | 'device-bleed';
export const COMPOSE_LAYOUTS: readonly ComposeLayout[] = ['text-top', 'text-bottom', 'device-bleed'];

/**
 * How a screenshot is presented:
 * - `device` (default): inside a device frame mockup.
 * - `frameless`: the bare screenshot with rounded corners + a soft shadow.
 * - `zoom`: a magnified crop of the screen's selling UI (`crop`, else the `focus` band), rounded + shadow.
 */
export type ComposePresentation = 'device' | 'frameless' | 'zoom';
export const COMPOSE_PRESENTATIONS: readonly ComposePresentation[] = ['device', 'frameless', 'zoom'];

/** `auto` (default): the no-tangent rule picks clear-with-margin or a decisive bleed. */
export type ComposeBleed = BleedPreference;
export const COMPOSE_BLEEDS: readonly ComposeBleed[] = ['auto', 'none', 'deep'];

/** Fonts the editor offers (Inter is web-loaded; the rest are system fonts). */
export const COMPOSE_FONTS: readonly string[] = [
	'Inter',
	'Arial',
	'Helvetica',
	'Georgia',
	'Times New Roman',
	'Courier New',
	'Verdana',
	'Trebuchet MS',
	'Impact',
	'Comic Sans MS'
];

/** Fractions (0–1) of the screenshot: a crop rectangle for `zoom`. */
export interface ComposeCrop {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Set-wide background system, used for screens that omit `background`. */
export interface ComposePalette {
	/**
	 * `family`: every screen shares one gradient through `colors`. `sequence`: screen i uses
	 * colors[i % n]. `tonal` (0.5.0): `colors` = [base, accent?] brand colours → light↔deep steps of
	 * the base hue per screen (`tone`), the accent for badges / motif. Every mode gets ONE set-wide
	 * text colour that passes WCAG ≥ 4.5 on every palette background (tones are adjusted until it does).
	 */
	mode: 'family' | 'sequence' | 'tonal';
	colors: string[];
	/** `tonal` only: `light` (pale tints, dark text), `vivid` (the brand colour itself, default), `deep`. */
	tone?: PaletteTone;
}

export const COMPOSE_PALETTE_TONES: readonly PaletteTone[] = ['light', 'vivid', 'deep'];

export interface ComposePanorama {
	/**
	 * Runs of adjacent screen indices sharing one continuous background, e.g. [[0, 1], [2, 3]]. May be
	 * omitted (no spans) — e.g. a plan that only picks the `decoration` concept C of `makeVariants` uses.
	 */
	spans?: number[][];
	/**
	 * Devices that cross a seam into the next screen: `true` = the first screen of EVERY span, or a
	 * list of screen indices (each must be the first screen of a span). Default none. More than one
	 * straddle per set is allowed but lint-warned (`panorama-straddle-count`).
	 */
	straddle?: boolean | number[];
	/**
	 * Seam decoration. `orbs` (default): soft circles on each seam. `honeycomb` / `wave` (0.5.0): one
	 * continuous motif path across the whole span, crossing every seam. `none`.
	 */
	decoration?: Motif;
}

/** Brand art (a mascot, a logo mark) uploaded like a screenshot (transparent PNG). */
export interface ComposeArt {
	id: string;
	/** Uploaded-asset URL (/api/screenshots/<id>/raw) — same rule as screenshots. */
	url: string;
	width: number;
	height: number;
	/** Which way the art faces; lets the composer flip it to face into the canvas. */
	faces?: 'left' | 'right';
}

export type MascotAnchor = 'headline' | 'device-top' | 'device-side' | 'seam';
export const MASCOT_ANCHORS: readonly MascotAnchor[] = ['headline', 'device-top', 'device-side', 'seam'];

export interface ComposeMascot {
	/** `art[].id` of the plan. */
	art: string;
	/** Where it goes (fallbacks are tried when it doesn't fit). Default `headline`. */
	anchor?: MascotAnchor;
	/** Rendered width ÷ W. Default 0.3 on the hero, 0.22 elsewhere. */
	size?: number;
	/** Mirror it horizontally (default: face into the canvas when the art declares `faces`). */
	flip?: boolean;
}

/**
 * The hero (screen 1 by default): larger type, optional mascot + badge, and/or tilt. Prefers a deeper
 * bleed, but clears rather than leave a gap under the text.
 */
export interface ComposeHero {
	/** Hero screen index. Default 0. */
	screen?: number;
	/** Headline scale vs the set size (1–1.4). Default 1.25 (reduced when it would add a line). */
	scale?: number;
	layout?: ComposeLayout;
	/** Default `deep` (unless the set's bleed is `none`). */
	bleed?: ComposeBleed;
	/** Degrees; default: the screen's own tilt. */
	tilt?: number;
	mascot?: ComposeMascot;
	/** Hero badge (else the screen's own `badge`). */
	badge?: string;
}

/** Accent rhythm: every `every`-th screen (4th, 8th… for 4) gets a different treatment. */
export interface ComposeRhythm {
	/** 3–6. */
	every: number;
	/** `text-bottom` (default): device on top, text below. `callout`: a magnified callout + deeper bleed. */
	treatment?: 'text-bottom' | 'callout';
}

/** Plan-level style (all optional; an empty style composes exactly like a plan without one). */
export interface ComposeStyle {
	presentation?: ComposePresentation;
	/** Degrees (clockwise) for the accented screens listed in `tiltScreens`. Default 0. */
	tilt?: number;
	/** Screen indices that get `tilt`. Default: none. */
	tiltScreens?: number[];
	bleed?: ComposeBleed;
	palette?: ComposePalette;
	panorama?: ComposePanorama;
	/** Font family for all text (one of COMPOSE_FONTS). Default Inter. */
	font?: string;
	/** 0.5.0: the hero screen. Default on for screen 1 (`{}`); `false` turns it off. */
	hero?: ComposeHero | false;
	/** 0.5.0: accent rhythm (default none). */
	rhythm?: ComposeRhythm;
	/** 0.5.0: `auto` derives a magnified callout from `focus` on screens without an explicit one. Default `none`. */
	callouts?: 'auto' | 'none';
	/** 0.5.0: soft drop shadows on devices, frameless shots, callouts and mascots. Default true. */
	shadows?: boolean;
}

/** One screen's worth of plan input (the skill decides these per benefit). */
export interface ComposeScreenPlan {
	headline: string;
	headlineColor?: string;
	/** Optional short supporting line under the headline (smaller, slightly muted). */
	subheadline?: string;
	/** Defaults to `headlineColor` (rendered at reduced opacity). */
	subheadlineColor?: string;
	/** Defaults to `text-top`. */
	layout?: ComposeLayout;
	/**
	 * Required unless the plan has `style.palette`. In a panorama span every screen shows the span's
	 * FIRST screen's background.
	 */
	background?: BackgroundJSON;
	screenshot: { url: string; width: number; height: number };
	deviceId: string;
	/** Fractions of the screenshot height that must stay visible (the selling UI). */
	focus?: FocusBand;
	/** Zoom crop (fractions of the screenshot); defaults to the focus band. */
	crop?: ComposeCrop;
	/** Overrides `style.presentation` for this screen. */
	presentation?: ComposePresentation;
	/** Overrides the style tilt for this screen (degrees, clockwise). */
	tilt?: number;
	/** Short social-proof pill above the headline, e.g. "Teacher-approved". */
	badge?: string;
	/**
	 * 0.5.0: magnified callout of the selling element — a crop (fractions of the screenshot) shown
	 * 1.6–2.2× larger, overlapping the device. `false` disables an auto callout on this screen.
	 */
	callout?: ComposeCrop | false;
	/** 0.5.0: mascot / brand art on this screen. */
	mascot?: ComposeMascot;
}

export interface ComposePlan {
	name: string;
	screens: ComposeScreenPlan[];
	canvasWidth?: number;
	canvasHeight?: number;
	style?: ComposeStyle;
	/** 0.5.0: brand art (mascots) referenced by `mascot.art`. */
	art?: ComposeArt[];
}

export interface ComposeWarning {
	/** Screen index, when the warning is about one screen. */
	screen?: number;
	code:
		| 'headline-words'
		| 'headline-lines'
		| 'subheadline-lines'
		| 'tilt-count'
		| 'panorama-seam'
		| 'straddle-skipped'
		| 'tilt-reduced'
		| 'panorama-straddle-count'
		| 'zoom-focus-cropped'
		| 'badge-long'
		| 'headline-orphan'
		| 'contrast-low'
		| 'callout-skipped'
		| 'mascot-skipped';
	message: string;
}

/** Per-screen geometry summary (canvas-relative), for reports and tests. */
export interface ComposeScreenMetrics {
	index: number;
	presentation: ComposePresentation;
	layout: ComposeLayout;
	/** Screens with the same group share scale, baseline and far-edge treatment. */
	group: string;
	/** Rendered subject scale (device scaleX; image scaleX for frameless/zoom). */
	scale: number;
	/** Rendered (unrotated) subject width ÷ W. */
	widthFraction: number;
	/** Subject's rotated bounding-box top / bottom ÷ H. */
	top: number;
	bottom: number;
	/** Far-edge overshoot ÷ H (> 0 bleeds off the canvas). */
	overshoot: number;
	/** Far-edge overshoot ÷ the subject's rendered (rotated) height. */
	bleedFraction: number;
	mode: 'clear' | 'bleed';
	/** True if the far edge sits in the forbidden "just touching" band (never, by construction). */
	tangent: boolean;
	/** Headline font size ÷ W. */
	headlineSize: number;
	/** Headline box top ÷ H (identical across a set by construction). */
	headlineTop: number;
	/**
	 * Bottom of the reserved text block (headline + subheadline + badge row) ÷ H. For `text-bottom`
	 * layouts the text block sits near the canvas bottom (not the top), so `top − textBottom` (the
	 * subject's top minus this) isn't a meaningful "gap under the text" for that layout.
	 */
	textBottom: number;
	tilt: number;
	/** Horizontal centre ÷ W (≠ 0.5 for a straddling panorama device). */
	centerX: number;
	/** 0.5.0: `hero`, `accent` (rhythm) or `set` (the shared system). */
	role: ScreenRole;
	/** The headline as set, line by line. */
	headlineLines: string[];
	/** The headline text colour. */
	textColor: string;
	/**
	 * Where it comes from: `set` (the ONE set-wide colour), `screen` (this explicit background can't
	 * reach WCAG AA with the set colour, so it got its own), `plan` (an explicit headlineColor).
	 */
	textColorSource: 'set' | 'screen' | 'plan';
	/** Worst WCAG contrast of the text colour over this screen's background. */
	contrast: number;
	/** Callout card (canvas units), when emitted. */
	callout?: Rect & { magnification: number; focusCover: number };
	/** Mascot box on this screen (canvas units; may extend past a seam). */
	mascot?: Rect;
}

export type ScreenRole = 'hero' | 'accent' | 'set';

export interface ComposeReport {
	warnings: ComposeWarning[];
	screens: ComposeScreenMetrics[];
}

// ---------------------------------------------------------------------------
// Layout proportions. EVERYTHING below is a fraction of the canvas — there are no absolute pixel
// constants, so the same plan composes to a proportionally identical layout at 280×608 (editor
// units) or 1320×2868 (native iPhone 6.9" pixels).
// ---------------------------------------------------------------------------

/**
 * Typographic unit. On portrait phone canvases this is the canvas width; on squatter canvases
 * (tablet, laptop) it's capped by the height so text doesn't swallow a landscape canvas.
 */
const TYPE_UNIT_HEIGHT_CAP = 0.55; // unit = min(W, 0.55·H)
/** × unit — ONE headline size for the whole set (copy that doesn't fit is a lint warning, never a shrink). */
export const HEADLINE_SIZE = 0.085;
const HEADLINE_LINE_HEIGHT = 1.1;
const SUBHEADLINE_RATIO = 0.5; // subheadline size ÷ headline size (a real second tier)
const SUBHEADLINE_LINE_HEIGHT = 1.25;
const SUBHEADLINE_WEIGHT = '600';
/** Subheadline = the text colour tinted this far toward the brand hue (kept only if it stays ≥ AA). */
const SUBHEADLINE_TINT = 0.18;
/** …and the tint is used only when it clears AA with this margin (never a 4.49 by rounding). */
const SUBHEADLINE_TINT_MIN = 4.6;
/** Hero headline scale (× the set size) and its bounds. */
const HERO_SCALE = 1.25;
const HERO_SCALE_RANGE = [1, 1.4] as const;
/**
 * × W → 6% side padding each side. The width model is conservative (a line estimated to fit renders
 * narrower), so the visible text keeps a wider margin than the box.
 */
const TEXT_WIDTH = 0.88;
/**
 * Conservative per-font text metrics for line-wrap estimates (and so the reserved text area):
 * px per character "unit" (see `charUnits`; 1 unit ≈ an average lowercase letter) × the font size.
 * Calibrated from node-canvas measurements of macOS system fonts (bold, mixed case, ALL CAPS,
 * narrow/wide stress strings) + ~10% headroom, so an estimate of N lines never renders as N+1;
 * see src/lib/utils/composeFonts.canvas.test.ts in the app. Inter (web font, not installed for the
 * measurement) is set ~10% wider than Arial. Courier New is monospace: every character is 1 unit.
 */
export const FONT_CHAR_WIDTH: Readonly<Record<string, number>> = {
	Inter: 0.66,
	Arial: 0.64,
	Helvetica: 0.64,
	Georgia: 0.72,
	'Times New Roman': 0.63,
	'Courier New': 0.66,
	Verdana: 0.76,
	'Trebuchet MS': 0.68,
	Impact: 0.64,
	'Comic Sans MS': 0.76
};
const MONOSPACE_FONTS = new Set(['Courier New']);
const AVG_CHAR_WIDTH = FONT_CHAR_WIDTH.Inter;

/** A font name (→ FONT_CHAR_WIDTH) or a raw px-per-unit factor. */
export type TextMetrics = string | number;
const metricsOf = (m: TextMetrics) =>
	typeof m === 'number' ? { charWidth: m, mono: false } : { charWidth: FONT_CHAR_WIDTH[m] ?? AVG_CHAR_WIDTH, mono: MONOSPACE_FONTS.has(m) };

const EDGE_MARGIN = 0.055; // × H — gap between the text block and the canvas edge
const TEXT_GAP = 0.45; // × headline font size — headline ↔ subheadline gap
const DEVICE_GAP = 0.04; // × unit — text block ↔ device gap

/** Copy rules (lint). */
export const COPY_RULES = { headlineMaxWords: 5, headlineMaxLines: 2, subheadlineMaxLines: 1, maxTiltedScreens: 2 } as const;

// Badge pill (social proof), reserved as a row above the headline set-wide when any screen has one.
const BADGE_FONT = 0.36; // × headline size
const BADGE_PAD_X = 1.1; // × badge font
const BADGE_HEIGHT = 2.1; // × badge font
const BADGE_GAP = 0.45; // × headline size — badge ↔ headline
const BADGE_MAX_CHARS = 28;

// Frameless / zoom styling.
const FRAMELESS_WIDTH = 0.9; // × the layout's device width target (no bezel → a touch narrower)
const FRAMELESS_RADIUS = 0.1; // × rendered width — fallback, and the cap for `frameCornerRadiusRatio`
const FRAMELESS_RADIUS_MIN = 0.03; // × rendered width — floor for a device with squarer screen corners (e.g. iPad)
const ZOOM_WIDTH = 0.88; // × W
const ZOOM_RADIUS = 0.05; // × W
const ZOOM_MIN_ASPECT = 0.5; // card height ≥ half its width
const SHADOW = { color: 'rgba(0,0,0,0.28)', blur: 0.07, offsetY: 0.025 }; // blur/offset × W
/** Device frames: `fabricData.deviceShadow` (canvas units) — the editor casts it from the screen area. */
const DEVICE_SHADOW = { blur: 0.075, offsetY: 0.03 };
const CALLOUT_SHADOW = { blur: 0.06, offsetY: 0.02 };
const MASCOT_SHADOW = { blur: 0.035, offsetY: 0.012 };

// Callouts (magnified selling element).
const CALLOUT_TARGET_WIDTH = 0.8; // × W — the card width aimed for
const CALLOUT_MARGIN = 0.035; // × W — side margin of the card
const CALLOUT_EDGE = 0.04; // × H — far-edge margin
const CALLOUT_TEXT_GAP = 0.02; // × H — gap under / over the text block
export const CALLOUT_MAG = { min: 1.6, max: 2.2, floor: 1.25 } as const;
/**
 * A callout may cover its own source slice (the pop-out), but at most this share of the REST of the
 * focus band — it is moved (up/down, out to a side edge) or made smaller, else skipped.
 */
export const CALLOUT_MAX_FOCUS_COVER = 0.35;
const CALLOUT_RADIUS = 0.035; // × W
/**
 * Padding added around the requested callout crop (screenshot px), as a multiple of the rounded
 * mask's LOCAL corner radius (`CALLOUT_RADIUS * W`, converted to the crop's own pixel space — see
 * `calloutGeometry`), so the rounded corners of the clip mask (`makeCalloutLayer`) don't cut into
 * content at the requested crop's own corners (e.g. selection handles). The geometric minimum to
 * keep a corner point inside a rounded corner of radius `rx` is `1 - 1/√2 ≈ 0.293`; the extra margin
 * covers the fact that padding the crop shrinks the eventual magnification a little further.
 */
const CALLOUT_CORNER_PAD = 0.35;
// Auto crop: fractions of the screenshot width (left-aligned — UI rows start at the left, so a cut
// at the right loses a chevron, not the first letters of a label); card h ÷ w.
const CALLOUT_AUTO = { x: 0.02, w: 0.64, aspect: 0.4 };
/** `callouts: "auto"` only derives a callout where the focus band is this tight (a specific selling element). */
export const CALLOUT_AUTO_MAX_FOCUS = 0.5;

// Mascot.
const MASCOT_SIZE = { hero: 0.3, screen: 0.22 }; // × W
const MASCOT_MARGIN = 0.02; // × W from the canvas edges
const MASCOT_PAD = 0.012; // × W clearance from text / callouts
const MASCOT_FOCUS_INSET = 0.1; // × W — the focus band's outer edges may be overlapped by this much

// Panorama.
const STRADDLE_OVERLAP = 0.3; // × the device's visible width that crosses the seam (target)
/** 0.5.0: at least this much of the device must show on the next screen, else no straddle (a sliver reads as a glitch). */
export const STRADDLE_MIN = 0.18;
const MAX_STRADDLES = 1; // seam crossings per set before a lint warning
const ORB_RADIUS = 0.34; // × W
const ORB_Y = 0.7; // × H
const ORB_MIN_RADIUS = 0.08; // × W — smaller than this, the orb is dropped
const ORB_TEXT_GAP = 0.02; // × H — orbs keep this far from a text block

interface LayoutSpec {
	/** Target rendered device width as a fraction of the canvas width. */
	deviceWidth: number;
	/** Max fraction of the device's height allowed off-canvas (bounds the scale on squat canvases). */
	maxBleed: number;
	/** Device can't start above this fraction of H (text-top variants) — pushes the hero lower. */
	minDeviceTop: number;
}

const LAYOUTS: Record<ComposeLayout, LayoutSpec> = {
	'text-top': { deviceWidth: 0.86, maxBleed: 0.2, minDeviceTop: 0 },
	'text-bottom': { deviceWidth: 0.9, maxBleed: 0.2, minDeviceTop: 0 },
	// Capped at NO_TANGENT.maxWidth (90% W — a 5% side margin); the hero differs by sitting lower.
	'device-bleed': { deviceWidth: 0.9, maxBleed: 0.4, minDeviceTop: 0.28 }
};

/**
 * Relative advance of a character (1 = an average lowercase letter). Capitals and m/w are wide,
 * i/l/punctuation narrow — so ALL-CAPS or "Mm Ww" copy isn't under-estimated.
 */
function charUnits(ch: string): number {
	if (ch === ' ') return 0.5;
	// CJK / kana / Hangul / fullwidth glyphs are ~1 em: 1 / 0.66 ≈ 1.52 units, + headroom.
	if (isWideChar(ch)) return WIDE_CHAR_UNITS;
	if ("iljI.,:;!|'’".includes(ch)) return 0.5;
	if ('ftr()[]-–'.includes(ch)) return 0.7;
	if ('mwMW'.includes(ch)) return 1.55;
	if (ch >= 'A' && ch <= 'Z') return 1.3;
	return 1;
}

/** Width (in average-letter units) of a CJK / fullwidth glyph: ~1 em ÷ the 0.66 em unit, + headroom. */
const WIDE_CHAR_UNITS = 1.6;

/** Estimated rendered width of `text` (single line) — the width model behind `estimateLines`. */
export function estimateTextWidth(text: string, fontSize: number, metrics: TextMetrics = 'Inter'): number {
	const { charWidth, mono } = metricsOf(metrics);
	return [...text].reduce((sum, ch) => sum + (isWideChar(ch) ? WIDE_CHAR_UNITS : mono ? 1 : charUnits(ch)), 0) * fontSize * charWidth;
}

/**
 * Greedy word-wrap estimate (Fabric Textbox semantics: wrap at spaces) of how
 * many lines `text` takes at `fontSize` in a box `width` wide, in the font `metrics` (a COMPOSE_FONTS
 * name, or a raw px-per-unit factor).
 */
export function estimateLines(text: string, fontSize: number, width: number, metrics: TextMetrics = 'Inter'): number {
	const { charWidth, mono } = metricsOf(metrics);
	const unit = fontSize * charWidth;
	const maxUnits = Math.max(1, width / unit);
	const cu = (ch: string) => (isWideChar(ch) ? WIDE_CHAR_UNITS : mono ? 1 : charUnits(ch));
	const units = (w: string) => [...w].reduce((sum, ch) => sum + cu(ch), 0);
	let lines = 0;
	for (const paragraph of text.split('\n')) {
		let current = 0;
		lines++;
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			const len = units(word);
			if (current === 0) {
				current = len;
			} else if (current + cu(' ') + len <= maxUnits) {
				current += cu(' ') + len;
			} else {
				lines++;
				current = len;
			}
			// A word wider than the line does NOT wrap in Fabric's Textbox (it widens the box to the
			// word — see `overlongWords`; composeSet rejects such copy). Unspaced CJK runs are one
			// "word" here; counting them as wrapping per line keeps this estimate conservative.
			while (current > maxUnits) {
				lines++;
				current -= maxUnits;
			}
		}
	}
	return Math.max(1, lines);
}

/** Set typography for one canvas size. */
interface Typography {
	W: number;
	H: number;
	unit: number;
	headlineSize: number;
	subSize: number;
	textWidth: number;
	margin: number;
	deviceGap: number;
	/** Reserved badge row (0 when no screen of this size has a badge). */
	badgeRow: number;
	badgeFont: number;
	/** The set font (text metrics: FONT_CHAR_WIDTH). */
	font: string;
	/** Reserved text-block height = the TALLEST block among screens of this size. */
	textArea: number;
}

interface TextBlock {
	/** The headline as set (balanced / explicit breaks). */
	headline: string[];
	sub: string[];
	headlineLines: number;
	headlineHeight: number;
	subLines: number;
	subHeight: number;
	gap: number;
	height: number;
}

/** Lines of `text` at `size` in the box: explicit `\n` + balanced breaks (see typography.ts). */
function setLines(text: string, size: number, t: Pick<Typography, 'textWidth' | 'font'>): string[] {
	// A line the balancer had to leave raw (an over-long word) still wraps in Fabric; measureTextBlock
	// counts it with estimateLines.
	return breakLines(text, t.textWidth, (line) => estimateTextWidth(line, size, t.font));
}

function measureTextBlock(screen: ComposeScreenPlan, t: Omit<Typography, 'textArea'>): TextBlock {
	const headline = setLines(screen.headline, t.headlineSize, t);
	const headlineLines = headline.reduce((n, line) => n + estimateLines(line, t.headlineSize, t.textWidth, t.font), 0);
	const headlineHeight = headlineLines * t.headlineSize * HEADLINE_LINE_HEIGHT;
	const hasSub = !!screen.subheadline?.trim();
	const sub = hasSub ? setLines(screen.subheadline!, t.subSize, t) : [];
	const subLines = sub.reduce((n, line) => n + estimateLines(line, t.subSize, t.textWidth, t.font), 0);
	const subHeight = subLines * t.subSize * SUBHEADLINE_LINE_HEIGHT;
	const gap = hasSub ? t.headlineSize * TEXT_GAP : 0;
	return { headline, sub, headlineLines, headlineHeight, subLines, subHeight, gap, height: t.badgeRow + headlineHeight + gap + subHeight };
}

/** Everything decided per screen before layers are built. */
interface ResolvedScreen {
	index: number;
	plan: ComposeScreenPlan;
	W: number;
	H: number;
	layout: ComposeLayout;
	presentation: ComposePresentation;
	tilt: number;
	background: BackgroundJSON;
	backgroundFromStyle: boolean;
	typo: Typography;
	block: TextBlock;
	group: string;
	role: ScreenRole;
	/** Bleed preference of this screen's group (the hero defaults to `deep`). */
	bleed: BleedPreference;
	/** Badge text (hero badge or the screen's own). */
	badge?: string;
	/** Callout crop request (fractions), resolved from `callout` / `style.callouts` / rhythm. */
	calloutReq?: ComposeCrop;
	mascot?: ComposeMascot;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function normalizeFocus(focus: FocusBand | undefined): FocusBand | undefined {
	if (!focus || typeof focus.top !== 'number' || typeof focus.bottom !== 'number') return undefined;
	const top = clamp01(Math.min(focus.top, focus.bottom));
	const bottom = clamp01(Math.max(focus.top, focus.bottom));
	return bottom > top ? { top, bottom } : undefined;
}

/** A background's colour stops (solid → a subtle two-stop ramp around it). */
function backgroundStops(bg: BackgroundJSON): ColorStop[] {
	const stops = bg.gradient?.colorStops;
	if (bg.type === 'gradient' && stops && stops.length > 0) return stops;
	// v1 gradients list bare `colors` (evenly spaced), like the editor's migrateScreenLayersJSON.
	const v1 = bg.gradient?.colors?.filter(isHexColor) ?? [];
	if (bg.type === 'gradient' && v1.length > 0) return evenStops(v1.length === 1 ? [v1[0], v1[0]] : v1);
	const c = isHexColor(bg.color) ? bg.color : '#1F2937';
	return [
		{ offset: 0, color: lighten(c, 0.14) },
		{ offset: 1, color: darken(c, 0.14) }
	];
}

function evenStops(colors: string[]): ColorStop[] {
	return colors.map((color, i) => ({ offset: colors.length > 1 ? i / (colors.length - 1) : 0, color }));
}

const linear = (colorStops: ColorStop[]): BackgroundJSON => ({ type: 'gradient', gradient: { type: 'linear', colorStops } });

/** Background from the plan-level palette (null when there is none / it's unusable). `step`: tonal step. */
function paletteBackground(palette: ComposePalette | undefined, index: number, step = index): BackgroundJSON | null {
	const colors = (palette?.colors ?? []).filter(isHexColor);
	if (!palette || colors.length === 0) return null;
	if (palette.mode === 'tonal') {
		const tone = (COMPOSE_PALETTE_TONES as readonly string[]).includes(palette.tone ?? '') ? palette.tone! : 'vivid';
		return tonalBackground(colors[0], tone, step);
	}
	if (palette.mode === 'sequence') {
		const c = colors[index % colors.length];
		return linear([
			{ offset: 0, color: lighten(c, 0.16) },
			{ offset: 1, color: c }
		]);
	}
	return linear(evenStops(colors.length === 1 ? [colors[0], darken(colors[0], 0.22)] : colors));
}

/** Colour of a ramp of `stops` at parameter t ∈ [0, 1] (non-hex stops are ignored). */
function colorAt(stops: ColorStop[], t: number): string {
	const sorted = stops.filter((c) => isHexColor(c.color)).sort((a, b) => a.offset - b.offset);
	if (sorted.length === 0) return '#1F2937';
	if (t <= sorted[0].offset) return sorted[0].color;
	for (let i = 1; i < sorted.length; i++) {
		const a = sorted[i - 1];
		const b = sorted[i];
		if (t <= b.offset) return mixHex(a.color, b.color, b.offset > a.offset ? (t - a.offset) / (b.offset - a.offset) : 1);
	}
	return sorted[sorted.length - 1].color;
}

type Coords = { x1: number; y1: number; x2: number; y2: number };

/** Ramp parameter (0–1, padded at the ends) of point (x, y) on a linear gradient from p1 to p2. */
function rampT(c: Coords, x: number, y: number): number {
	const dx = c.x2 - c.x1;
	const dy = c.y2 - c.y1;
	const len2 = dx * dx + dy * dy || 1;
	return clamp01(((x - c.x1) * dx + (y - c.y1) * dy) / len2);
}

/** Where the editor draws an angle-based gradient over a w×h box (mirrors `deserializeBackground`). */
function angleCoords(angle: number | undefined, w: number, h: number): Coords {
	const rad = (((angle || 180) - 90) * Math.PI) / 180;
	return {
		x1: (0.5 + Math.cos(rad) * 0.5) * w,
		y1: (0.5 + Math.sin(rad) * 0.5) * h,
		x2: (0.5 - Math.cos(rad) * 0.5) * w,
		y2: (0.5 - Math.sin(rad) * 0.5) * h
	};
}

/**
 * Colour of a LINEAR screen background at canvas point (x, y), placed exactly as the editor draws it
 * (mirrors `deserializeBackground`: explicit coords, else `angle` — default 180°, i.e. offset 0 at
 * the BOTTOM edge). Radial gradients are not modelled (they are sampled as if linear): auto-contrast
 * only ever samples palette backgrounds, which are always linear, and panorama spans, which reject
 * radial backgrounds.
 */
export function sampleBackground(bg: BackgroundJSON, W: number, H: number, x: number, y: number): string {
	if (bg.type !== 'gradient' || !bg.gradient) return isHexColor(bg.color) ? bg.color : '#1F2937';
	return colorAt(backgroundStops(bg), rampT(bg.gradient.coords ?? angleCoords(bg.gradient.angle, W, H), x, y));
}

/** What a panorama span paints across its N·W × H rect. */
type SpanFill = { kind: 'solid'; color: string } | { kind: 'linear'; stops: ColorStop[]; coords: Coords };

/**
 * The span-start screen's background, stretched across the whole span, keeping its colours, stop
 * offsets and `angle` (an angle-less gradient runs diagonally corner to corner; a solid colour stays
 * solid). Rejects what can't run across screens: radial gradients and explicit per-screen `coords`.
 */
function spanFillFor(bg: BackgroundJSON, first: number, N: number, W: number, H: number): SpanFill {
	if (bg.type !== 'gradient' || !bg.gradient) return { kind: 'solid', color: isHexColor(bg.color) ? bg.color : '#1F2937' };
	const at = `panorama span starting at screen ${first + 1}`;
	if (bg.gradient.type === 'radial') {
		throw new Error(`${at}: a radial gradient background can't run across screens — use a linear gradient or a solid colour`);
	}
	if (bg.gradient.coords) {
		throw new Error(`${at}: explicit gradient \`coords\` are per-screen and can't span screens — use \`angle\` (or omit it) instead`);
	}
	const stops = backgroundStops(bg);
	const coords = bg.gradient.angle != null ? angleCoords(bg.gradient.angle, N * W, H) : { x1: 0, y1: 0, x2: N * W, y2: H };
	return { kind: 'linear', stops, coords };
}

/** Colour of a span fill at point (x, y) of span screen k. */
function samplePanorama(fill: SpanFill, k: number, W: number, x: number, y: number): string {
	return fill.kind === 'solid' ? fill.color : colorAt(fill.stops, rampT(fill.coords, k * W + x, y));
}

/** The subject (what is placed under the text) of a framed / frameless screen. */
function subjectFor(r: ResolvedScreen): Subject {
	if (r.presentation === 'device') {
		const device = getDeviceFrame(r.plan.deviceId);
		if (!device) throw new Error(`Unknown device: ${r.plan.deviceId}`);
		const { width, height } = device.imageDimensions;
		return { width, height, screen: { ...device.screenBounds } };
	}
	const { width, height } = r.plan.screenshot;
	return { width, height, screen: { x: 0, y: 0, width, height } };
}

interface Placement {
	cx: number;
	cy: number;
	scale: number;
	angle: number;
	/** Rendered rotated bounding box. */
	boxWidth: number;
	boxHeight: number;
	vertical: VerticalResult;
	subject: Subject;
	/** Straddlers only: validated rightward shift that makes the device cross the seam. */
	straddleDx?: number;
	/** zoom only */
	zoom?: { cropX: number; cropY: number; cropW: number; cropH: number; focusCropped: boolean };
}

/** Near-edge start for a screen's subject: below (or above, for text-bottom) the reserved text area. */
function nearStart(t: Typography): number {
	return t.margin + t.textArea + t.deviceGap;
}

/**
 * Fit a zoom crop (natural px) to the card aspect `A` = height / width, centred on the requested
 * region. An explicit `crop` keeps its full width (the model chose it); a focus-derived band always
 * shows the full screenshot width (B1). The height always covers the requested band when the image
 * allows (else `focusCropped`).
 */
function fitCrop(
	shot: { width: number; height: number },
	req: { x: number; y: number; w: number; h: number },
	A: number,
	explicit: boolean
): { cropX: number; cropY: number; cropW: number; cropH: number; focusCropped: boolean } {
	// B1 (0.5.0): only an explicit `crop` narrows the card; a focus-derived zoom shows the FULL
	// screenshot width (a half-width centre crop cut words off at both edges).
	const minW = explicit ? req.w : shot.width;
	let w = Math.min(shot.width, Math.max(minW, req.h / A));
	let h = w * A;
	if (h > shot.height) {
		h = shot.height;
		w = h / A;
	}
	const focusCropped = h < req.h - 0.5 || (explicit && w < req.w - 0.5);
	const cx = req.x + req.w / 2;
	const cy = req.y + req.h / 2;
	const cropX = Math.min(Math.max(0, cx - w / 2), shot.width - w);
	const cropY = Math.min(Math.max(0, cy - h / 2), shot.height - h);
	return { cropX, cropY, cropW: w, cropH: h, focusCropped };
}

const HORIZONTAL_EPS = 1e-9;
/** A tilted device may shrink to this × its straight scale to keep its margins; else the tilt is reduced. */
const TILT_MIN_SCALE = 0.8;

/**
 * The horizontal no-tangent + focus rules for one pose: the subject's VISIBLE extent keeps
 * `sideMargin`·W from both side edges (the right edge is waived for a deliberate straddle), and
 * every focus band's rotated corners stay `focusSideSafe`·W inside the edges.
 */
function horizontalOk(
	subject: Subject,
	pose: { cx: number; cy: number; scale: number; angle: number },
	W: number,
	H: number,
	focuses: FocusBand[],
	straddleRight = false
): boolean {
	const eps = HORIZONTAL_EPS * W;
	const ext = visibleXExtent(subject, pose, H);
	if (ext) {
		const m = NO_TANGENT.sideMargin * W;
		if (ext.min < m - eps) return false;
		if (!straddleRight && ext.max > W - m + eps) return false;
	}
	const fs = NO_TANGENT.focusSideSafe * W;
	return focuses.every((f) => {
		const fx = focusXExtent(subject, f, pose);
		return fx.min >= fs - eps && fx.max <= W - fs + eps;
	});
}

/**
 * Rightward shift for a panorama straddle: the visible device crosses the seam by STRADDLE_OVERLAP
 * of its visible width, limited so every focus band stays `focusSideSafe`·W inside the seam. Null
 * when that leaves less than a decisive STRADDLE_MIN crossing (or would move the device left).
 */
function straddleShift(
	subject: Subject,
	pose: { cx: number; cy: number; scale: number; angle: number },
	W: number,
	H: number,
	focuses: FocusBand[]
): number | null {
	const ext = visibleXExtent(subject, pose, H);
	if (!ext) return null;
	const visW = ext.max - ext.min;
	let dx = W + STRADDLE_OVERLAP * visW - ext.max;
	for (const f of focuses) dx = Math.min(dx, W * (1 - NO_TANGENT.focusSideSafe) - focusXExtent(subject, f, pose).max);
	const overlap = ext.max + dx - W;
	return dx > 0 && overlap >= STRADDLE_MIN * visW ? dx : null;
}

const screensOf = (members: ResolvedScreen[]) => members.map((m) => m.index + 1).join(', ');

/** The copy is the cause: the device gets < `minScale` of what it would get with no copy at all. */
const copyTooLong = (members: ResolvedScreen[], W: number, H: number) =>
	new Error(
		`copy too long for this canvas (${W}×${H}, screen ${screensOf(members)}): the text leaves the device ` +
			`less than ${Math.round(NO_TANGENT.minScale * 100)}% of the room it gets with no copy — cut the subheadline or headline`
	);

/** The canvas is the cause: even with no copy the subject can't reach a usable size. */
const canvasMismatch = (members: ResolvedScreen[], W: number, H: number, what: string, pct: number) =>
	new Error(
		`${what} doesn't fit a ${W}×${H} canvas (screen ${screensOf(members)}): even with no copy it renders at only ` +
			`${Math.round(pct * 100)}% of its target width — use the device's own canvas (omit canvasWidth/canvasHeight) or another device`
	);

/** Below this × its target width even with NO copy, the canvas (not the copy) is the problem. */
const MIN_EMPTY_COPY_FIT = 0.3;

/**
 * Pose of every screen in a group (they share scale, baseline and far-edge treatment).
 * Vertical: `solveVertical` (no tangent, focus visible). Horizontal: the pose must pass
 * `horizontalOk` for every member; if the tilt makes it too wide, the scale is capped (by at most
 * TILT_MIN_SCALE), then the tilt is reduced in quarter steps down to 0 (a straight device ≤ 90% W
 * always fits), with a `tilt-reduced` warning. Zoom cards follow the same ladder, keeping their
 * aspect. Throws `copyTooLong` when the copy leaves < minScale of the no-copy fit, and
 * `canvasMismatch` when even the no-copy fit is unusable (N1).
 */
function placeGroup(
	members: ResolvedScreen[],
	bleed: BleedPreference,
	warnings: ComposeWarning[],
	/** Every member is a requested panorama straddler: the right side margin is waived (it crosses the seam). */
	straddleRight = false
): Map<number, Placement> {
	const out = new Map<number, Placement>();
	const first = members[0];
	const { W, H, typo, layout, presentation, tilt } = first;
	const spec = LAYOUTS[layout] ?? LAYOUTS['text-top'];
	const farEdge = layout === 'text-bottom' ? 'top' : 'bottom';
	const near = nearStart(typo);
	const reduced = (to: number) => {
		if (to === tilt) return;
		warnings.push({
			screen: first.index,
			code: 'tilt-reduced',
			message: `screen ${members.map((m) => m.index + 1).join(', ')}: tilt reduced from ${tilt}° to ${Math.round(to * 10) / 10}° so the device and its focus band keep their side margins`
		});
	};

	if (presentation === 'zoom') {
		// One card box for the group. Straight, it spans the full remaining height (clear of the far
		// edge by the margin) at ZOOM_WIDTH·W, never flatter than ZOOM_MIN_ASPECT. That ASPECT is kept at
		// every tilt: a tilted card scales down (≤ TILT_MIN_SCALE) until its rotated bounding box fits
		// the remaining height and the 90%-W side margins; beyond that the tilt is reduced (quarter
		// steps, `tilt-reduced`), and a straight card always fits.
		const avail = H * (1 - NO_TANGENT.clearGap) - near;
		const availEmpty = H * (1 - NO_TANGENT.clearGap) - (typo.margin + typo.deviceGap);
		if (!(avail > 0) || avail < NO_TANGENT.minScale * availEmpty) throw copyTooLong(members, W, H);
		let baseW = ZOOM_WIDTH * W;
		const baseH = avail;
		if (baseH < baseW * ZOOM_MIN_ASPECT) {
			baseW = baseH / ZOOM_MIN_ASPECT;
		}
		const aspect = baseH / baseW;
		const maxBoxWidth = (1 - 2 * NO_TANGENT.sideMargin) * W;
		const fitAt = (angle: number) => {
			const rad = (angle * Math.PI) / 180;
			const sin = Math.abs(Math.sin(rad));
			const cos = Math.abs(Math.cos(rad));
			const k = Math.min(1, maxBoxWidth / (baseW * (cos + aspect * sin)), avail / (baseW * (sin + aspect * cos)));
			return { k, boxW: k * baseW, boxH: k * baseW * aspect };
		};
		let angleUsed = 0;
		let fit = fitAt(0);
		for (const angle of tilt === 0 ? [0] : [tilt, tilt * 0.75, tilt * 0.5, tilt * 0.25, 0]) {
			const f = fitAt(angle);
			if (angle === 0 || f.k >= TILT_MIN_SCALE - 1e-9) {
				angleUsed = angle;
				fit = f;
				break;
			}
		}
		reduced(angleUsed);
		const tiltUsed = angleUsed;
		const { boxW, boxH } = fit;
		const box = rotatedBox(boxW, boxH, tiltUsed);
		for (const r of members) {
			const shot = r.plan.screenshot;
			const focus = normalizeFocus(r.plan.focus);
			const crop = r.plan.crop;
			const req = crop
				? { x: clamp01(crop.x) * shot.width, y: clamp01(crop.y) * shot.height, w: Math.max(1, clamp01(crop.w) * shot.width), h: Math.max(1, clamp01(crop.h) * shot.height) }
				: focus
					? { x: 0, y: focus.top * shot.height, w: shot.width, h: (focus.bottom - focus.top) * shot.height }
					: { x: 0, y: 0, w: shot.width, h: Math.min(shot.height, shot.width * (boxH / boxW)) };
			const zoom = fitCrop(shot, req, boxH / boxW, !!crop);
			const scale = boxW / zoom.cropW;
			const nearEdge = near;
			const cy = farEdge === 'bottom' ? nearEdge + box.height / 2 : H - nearEdge - box.height / 2;
			const overshoot = nearEdge + box.height - H;
			out.set(r.index, {
				cx: W / 2,
				cy,
				scale,
				angle: tiltUsed,
				boxWidth: box.width,
				boxHeight: box.height,
				vertical: { scale, near: nearEdge, overshoot, mode: 'clear', bleedFraction: overshoot / box.height, reason: 'zoom card clears the edge' },
				subject: { width: zoom.cropW, height: zoom.cropH, screen: { x: 0, y: 0, width: zoom.cropW, height: zoom.cropH } },
				zoom
			});
		}
		return out;
	}

	const subject = subjectFor(first);
	const targetWidth = Math.min(spec.deviceWidth * (presentation === 'frameless' ? FRAMELESS_WIDTH : 1), NO_TANGENT.maxWidth);
	const targetScale = (targetWidth * W) / subject.width;
	// Every member's focus band is honoured by the shared pose (the most restrictive one decides).
	const focuses = members.map((r) => normalizeFocus(r.plan.focus)).filter((f): f is FocusBand => !!f);
	const solve = (angle: number, scaleCap?: number, nearOverride?: number) => {
		const box = rotatedBox(subject.width, subject.height, angle);
		const reaches = focuses.map((f) => focusReach(subject, f, angle, farEdge));
		const vertical = solveVertical({
			canvasWidth: W,
			canvasHeight: H,
			near: nearOverride ?? near,
			minNear: spec.minDeviceTop * H,
			baseWidth: subject.width,
			boxHeight: box.height,
			targetWidth,
			maxBleed: spec.maxBleed,
			focusReach: reaches.length ? Math.max(...reaches) : null,
			bleed,
			preferBleed: angle !== 0,
			scaleCap
		});
		const s = vertical.scale;
		const cy = farEdge === 'bottom' ? vertical.near + (s * box.height) / 2 : H - vertical.near - (s * box.height) / 2;
		return { vertical, box, cy, angle };
	};

	// L7 / N1: the room gate is relative to what the SAME subject gets on this canvas with NO copy
	// (height-limited on landscape canvases), so a tall device on a squat canvas isn't blamed on the
	// copy. Too small even with no copy ⇒ the canvas/device aspect is the problem.
	const straight = solve(0);
	const empty = solve(0, undefined, typo.margin + typo.deviceGap).vertical.scale;
	if (!(empty >= MIN_EMPTY_COPY_FIT * targetScale - 1e-9)) {
		throw canvasMismatch(members, W, H, presentation === 'device' ? `device ${first.plan.deviceId}` : 'this screenshot', empty / targetScale);
	}
	const minScale = NO_TANGENT.minScale * empty;
	if (!(straight.vertical.scale >= minScale - 1e-9)) throw copyTooLong(members, W, H);

	// A tilt may cost at most TILT_MIN_SCALE of the straight size; beyond that the tilt is reduced
	// (in quarter steps down to 0) rather than shrinking the device further.
	const tiltFloor = Math.max(minScale, TILT_MIN_SCALE * straight.vertical.scale);
	// Search: tilt candidates (reduced in quarter steps), each with a shrinking scale cap. A straddler
	// is judged AFTER its seam shift (right margin waived; left margin + focus vs seam checked); if no
	// straddling pose exists it is placed as a normal screen (the caller then skips the straddle).
	const search = (asStraddle: boolean) => {
		for (const angle of tilt === 0 ? [0] : [tilt, tilt * 0.75, tilt * 0.5, tilt * 0.25, 0]) {
			const floor = angle === 0 ? minScale : tiltFloor;
			let cap: number | undefined;
			for (let i = 0; i < 400; i++) {
				const sol = solve(angle, cap);
				const pose = { cx: W / 2, cy: sol.cy, scale: sol.vertical.scale, angle };
				if (sol.vertical.scale >= floor - 1e-9) {
					if (!asStraddle && horizontalOk(subject, pose, W, H, focuses)) return { sol, dx: undefined as number | undefined };
					if (asStraddle) {
						const dx = straddleShift(subject, pose, W, H, focuses);
						if (dx != null && horizontalOk(subject, { ...pose, cx: pose.cx + dx }, W, H, focuses, true)) return { sol, dx };
					}
				}
				const next = sol.vertical.scale * 0.985;
				if (next < floor) break;
				cap = next;
			}
		}
		return null;
	};
	// A straight, centred device at ≤ 90% W always passes; `straight` is the defensive fallback.
	const found = (straddleRight ? search(true) : null) ?? search(false) ?? { sol: straight, dx: undefined };
	const chosen = found.sol;
	reduced(chosen.angle);
	const s = chosen.vertical.scale;
	for (const r of members) {
		out.set(r.index, {
			cx: W / 2,
			cy: chosen.cy,
			scale: s,
			angle: chosen.angle,
			boxWidth: s * chosen.box.width,
			boxHeight: s * chosen.box.height,
			vertical: chosen.vertical,
			subject,
			straddleDx: found.dx
		});
	}
	return out;
}

/** Set-wide look shared by every layer builder. */
interface Look {
	shadows: boolean;
	/** rgba() shadow colour (a deep tint of the brand hue for tonal palettes). */
	shadowColor: string;
}

function shadowFor(W: number, scale: number, look: Look, spec: { blur: number; offsetY: number } = SHADOW) {
	// Fabric scales shadow blur/offset by the object's scale (the editor's shadow controls use the
	// same convention), so express them in the image's own units.
	return { color: look.shadowColor, blur: (spec.blur * W) / scale, offsetX: 0, offsetY: (spec.offsetY * W) / scale };
}

/**
 * Non-zoom frameless corner radius, as a ratio of the rendered width: the device's own screen corner
 * radius (relative to its screen width), clamped to [FRAMELESS_RADIUS_MIN, FRAMELESS_RADIUS]. A flat
 * FRAMELESS_RADIUS reads fine on an iPhone (its screen corners are nearly that round) but is far too
 * round on an iPad (squarer corners, wide screen) — round enough to eat into the status bar. Falls
 * back to FRAMELESS_RADIUS when the device is unknown.
 */
function frameCornerRadiusRatio(deviceId: string): number {
	const device = getDeviceFrame(deviceId);
	if (!device) return FRAMELESS_RADIUS;
	return Math.min(FRAMELESS_RADIUS, Math.max(FRAMELESS_RADIUS_MIN, device.cornerRadius / device.screenBounds.width));
}

/** Frameless / zoom subject: the uploaded screenshot as a plain image layer, rounded + shadowed. */
function makeScreenshotImageLayer(r: ResolvedScreen, p: Placement, look: Look): LayerJSON {
	const id = generateLayerId();
	const shot = r.plan.screenshot;
	const zoom = p.zoom;
	const width = zoom ? zoom.cropW : shot.width;
	const height = zoom ? zoom.cropH : shot.height;
	const radius = zoom ? ZOOM_RADIUS * r.W : frameCornerRadiusRatio(r.plan.deviceId) * width * p.scale;
	const fabricData: Record<string, unknown> = {
		type: 'image',
		src: shot.url,
		crossOrigin: 'anonymous',
		left: p.cx,
		top: p.cy,
		width,
		height,
		scaleX: p.scale,
		scaleY: p.scale,
		originX: 'center',
		originY: 'center',
		// Rounded corners in the image's local (unscaled) space — same shape the editor's corner
		// radius control writes (`imageCornerRadius` is in canvas units).
		clipPath: {
			type: 'Rect',
			left: 0,
			top: 0,
			width,
			height,
			rx: radius / p.scale,
			ry: radius / p.scale,
			originX: 'center',
			originY: 'center'
		},
		imageCornerRadius: radius,
		layerId: id,
		layerType: 'image'
	};
	if (look.shadows) fabricData.shadow = shadowFor(r.W, p.scale, look);
	if (zoom) {
		fabricData.cropX = zoom.cropX;
		fabricData.cropY = zoom.cropY;
	}
	if (p.angle) fabricData.angle = p.angle;
	return {
		id,
		name: zoom ? 'Screenshot (zoom)' : 'Screenshot',
		type: 'image',
		visible: true,
		locked: false,
		fabricData
	};
}

function makeSubjectLayer(r: ResolvedScreen, p: Placement, look: Look, cx = p.cx, name?: string): LayerJSON {
	if (r.presentation === 'device') {
		// One device layer; the screenshot rides on it as `fabricData.screenshot` and the editor
		// places + clips it under the frame on import (see DeviceScreenshotJSON).
		const layer = makeDeviceFrameLayer({
			deviceId: r.plan.deviceId,
			screenshotUrl: r.plan.screenshot.url,
			screenshotWidth: r.plan.screenshot.width,
			screenshotHeight: r.plan.screenshot.height,
			canvasWidth: r.W,
			canvasHeight: r.H,
			centerX: cx,
			centerY: p.cy,
			scale: p.scale,
			angle: p.angle,
			name
		});
		// 0.5.0: the frame's drop shadow, in CANVAS units. The editor casts it from the screenshot
		// (clipped to the screen shape) rather than from the frame PNG, whose transparent screen hole
		// would otherwise let the bezel's shadow fall onto the screen. Older editors ignore it.
		if (look.shadows) {
			(layer.fabricData as Record<string, unknown>).deviceShadow = {
				color: look.shadowColor,
				blur: DEVICE_SHADOW.blur * r.W,
				offsetX: 0,
				offsetY: DEVICE_SHADOW.offsetY * r.W
			};
		}
		return layer;
	}
	const layer = makeScreenshotImageLayer(r, p, look);
	(layer.fabricData as Record<string, unknown>).left = cx;
	if (name) layer.name = name;
	return layer;
}

/** Canvas corners of a screen's focus band for a given pose (null when no focus is marked). */
function focusPolygon(r: ResolvedScreen, p: Placement, cx: number) {
	const focus = normalizeFocus(r.plan.focus);
	if (!focus || p.zoom) return null;
	return focusCorners(p.subject, focus).map((pt) => subjectPointToCanvas(p.subject, pt, { cx, cy: p.cy, scale: p.scale, angle: p.angle }));
}

interface TextRects {
	badge?: Rect;
	headline: Rect;
	/** One box per headline line (estimated width — conservative, i.e. never narrower than rendered). */
	lines: Rect[];
	sub?: Rect;
}

const textRectList = (t: TextRects): Rect[] => [t.badge, t.headline, t.sub].filter((x): x is Rect => !!x);

function validateSpans(plan: ComposePlan, dims: Array<{ W: number; H: number }>): number[][] {
	const spans = plan.style?.panorama?.spans ?? [];
	const seen = new Set<number>();
	for (const span of spans) {
		if (!Array.isArray(span) || span.length < 2) throw new Error('panorama span must list at least 2 screens');
		span.forEach((idx, k) => {
			if (!Number.isInteger(idx) || idx < 0 || idx >= plan.screens.length) throw new Error(`panorama span index ${idx} is out of range`);
			if (k > 0 && idx !== span[k - 1] + 1) throw new Error('panorama span screens must be adjacent and ascending');
			if (seen.has(idx)) throw new Error(`screen ${idx} is in more than one panorama span`);
			seen.add(idx);
			if (dims[idx].W !== dims[span[0]].W || dims[idx].H !== dims[span[0]].H) {
				throw new Error('panorama span screens must share one canvas size');
			}
		});
	}
	const straddle = plan.style?.panorama?.straddle;
	if (Array.isArray(straddle)) {
		for (const idx of straddle) {
			if (!spans.some((span) => span[0] === idx)) throw new Error(`panorama straddle ${idx} is not the first screen of a span`);
		}
	}
	return spans;
}

function normalizeCrop(c: ComposeCrop | undefined | false): ComposeCrop | undefined {
	if (!c || typeof c !== 'object') return undefined;
	const x = clamp01(c.x);
	const y = clamp01(c.y);
	const w = Math.min(1 - x, clamp01(c.w));
	const h = Math.min(1 - y, clamp01(c.h));
	return [c.x, c.y, c.w, c.h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/**
 * Auto callout (`style.callouts: "auto"`): a left-aligned slice at the top of the focus band — only on
 * "selling" screens, i.e. where the band is tight (≤ CALLOUT_AUTO_MAX_FOCUS); a loose band says the
 * whole screen sells, and magnifying a blind slice of it adds noise. `force` (a `callout` accent)
 * skips that test.
 */
function autoCallout(screen: ComposeScreenPlan, force = false): ComposeCrop | undefined {
	const focus = normalizeFocus(screen.focus);
	if (!focus || (!force && focus.bottom - focus.top > CALLOUT_AUTO_MAX_FOCUS + 1e-9)) return undefined;
	const { width: sw, height: sh } = screen.screenshot;
	const h = Math.min(focus.bottom - focus.top, (CALLOUT_AUTO.w * sw * CALLOUT_AUTO.aspect) / sh);
	const y = Math.min(1 - h, focus.top + (focus.bottom - focus.top - h) * 0.15);
	return { x: CALLOUT_AUTO.x, y, w: CALLOUT_AUTO.w, h };
}

const HEX_TEXT_FALLBACK = '#ffffff';

/**
 * Two-pass SET layout: measure every text block → one type size + a text area reserved for the
 * tallest block (per canvas size) → one subject scale/baseline per group (canvas, presentation,
 * subject, layout, tilt, role) → the no-tangent bleed rule (respecting `focus`) → per-screen layers.
 * Copy length never moves or resizes anything; copy-rule violations come back as `report.warnings`.
 *
 * 0.5.0 art direction on top of that system: balanced line breaks, a hero screen (larger type,
 * deeper bleed, optional mascot + badge), an accent rhythm, a tonal brand palette with ONE text
 * colour per set (WCAG ≥ 4.5 everywhere), magnified callouts, mascots, shadows and continuous
 * panorama motifs. Non-accent screens still share one type size, text area, scale and baseline.
 */
export function composeSet(plan: ComposePlan): { template: Template; report: ComposeReport } {
	const style = plan.style ?? {};
	const warnings: ComposeWarning[] = [];
	const bleedPref: BleedPreference = (COMPOSE_BLEEDS as readonly string[]).includes(style.bleed ?? '') ? style.bleed! : 'auto';
	const font = style.font && COMPOSE_FONTS.includes(style.font) ? style.font : 'Inter';
	const tiltScreens = new Set(style.tiltScreens ?? []);
	const n = plan.screens.length;

	// Per-screen canvas dims: honor explicit plan-level dims (backward compatible), else derive from
	// the screen's device class so a mixed-device plan gets the correct aspect per screen.
	const explicit = plan.canvasWidth != null || plan.canvasHeight != null;
	const dims = plan.screens.map((screen) => {
		if (!getDeviceFrame(screen.deviceId)) throw new Error(`Unknown device: ${screen.deviceId}`);
		const { width, height } = explicit
			? { width: plan.canvasWidth ?? 280, height: plan.canvasHeight ?? 600 }
			: canvasDimsForDevice(screen.deviceId);
		return { W: width, H: height };
	});
	const spans = validateSpans(plan, dims);
	const spanOf = new Map<number, { span: number[]; k: number }>();
	for (const span of spans) span.forEach((idx, k) => spanOf.set(idx, { span, k }));

	// Brand art (mascots): uploaded-asset URLs only, like screenshots.
	const art = new Map<string, ComposeArt>();
	for (const a of plan.art ?? []) {
		if (!a || typeof a.id !== 'string' || !a.id) throw new Error('art entries need an id');
		if (!isUploadedScreenshotSrc(a.url)) throw new Error(`art "${a.id}": url must be an uploaded asset (/api/screenshots/<id>/raw)`);
		if (!(a.width > 0 && a.height > 0)) throw new Error(`art "${a.id}": width/height must be positive`);
		art.set(a.id, a);
	}

	// Roles: the hero (default screen 1) and the accent rhythm.
	const heroCfg: ComposeHero | null = style.hero === false ? null : style.hero && typeof style.hero === 'object' ? style.hero : {};
	const heroIndex = heroCfg && n > 0 ? Math.min(n - 1, Math.max(0, Math.floor(Number.isFinite(heroCfg.screen) ? heroCfg.screen! : 0))) : -1;
	const rhythm =
		style.rhythm && Number.isFinite(style.rhythm.every)
			? { every: Math.min(6, Math.max(3, Math.round(style.rhythm.every))), treatment: style.rhythm.treatment === 'callout' ? 'callout' : 'text-bottom' }
			: null;
	const roleOf = (i: number): ScreenRole => (i === heroIndex ? 'hero' : rhythm && i % rhythm.every === rhythm.every - 1 ? 'accent' : 'set');
	const heroBadge = heroCfg?.badge?.trim() || undefined;
	const badgeOf = (i: number) => (i === heroIndex ? (heroBadge ?? plan.screens[i].badge?.trim()) : plan.screens[i].badge?.trim()) || undefined;

	// Pass 1: set typography per canvas size (tallest text block wins); the hero gets its own scale.
	const typoByKey = new Map<string, Typography>();
	const dimsKey = (d: { W: number; H: number }) => `${d.W}x${d.H}`;
	const makeTypo = (i: number, scale: number, hasBadge: boolean): Typography => {
		const { W, H } = dims[i];
		const unit = Math.min(W, H * TYPE_UNIT_HEIGHT_CAP);
		const headlineSize = unit * HEADLINE_SIZE * scale;
		const badgeFont = unit * HEADLINE_SIZE * BADGE_FONT;
		return {
			W,
			H,
			unit,
			headlineSize,
			subSize: headlineSize * SUBHEADLINE_RATIO,
			textWidth: W * TEXT_WIDTH,
			margin: H * EDGE_MARGIN,
			deviceGap: unit * DEVICE_GAP,
			badgeFont,
			font,
			badgeRow: hasBadge ? badgeFont * BADGE_HEIGHT + unit * HEADLINE_SIZE * BADGE_GAP : 0,
			textArea: 0
		};
	};
	const typoFor = (i: number): Typography => {
		const hero = i === heroIndex;
		const key = `${dimsKey(dims[i])}|${hero ? 'hero' : 'set'}`;
		const cached = typoByKey.get(key);
		if (cached) return cached;
		let typo: Typography;
		if (hero) {
			// Hero scale: as large as asked, but it never adds a headline line (nor makes a word wider
			// than the box) — it steps down in 0.05s to 1× instead.
			const want = Math.min(HERO_SCALE_RANGE[1], Math.max(HERO_SCALE_RANGE[0], Number.isFinite(heroCfg?.scale) ? heroCfg!.scale! : HERO_SCALE));
			const hasBadge = !!badgeOf(i);
			const base = measureTextBlock(plan.screens[i], makeTypo(i, 1, hasBadge)).headlineLines;
			typo = makeTypo(i, 1, hasBadge);
			for (let s = want; s >= 1 - 1e-9; s -= 0.05) {
				const t = makeTypo(i, s, hasBadge);
				const fits = overlongWords(plan.screens[i].headline, t.textWidth, (w) => estimateTextWidth(w, t.headlineSize, t.font)).length === 0;
				if (fits && measureTextBlock(plan.screens[i], t).headlineLines <= base) {
					typo = t;
					break;
				}
			}
		} else {
			const hasBadge = plan.screens.some((_, j) => j !== heroIndex && dimsKey(dims[j]) === dimsKey(dims[i]) && !!badgeOf(j));
			typo = makeTypo(i, 1, hasBadge);
		}
		typoByKey.set(key, typo);
		return typo;
	};

	const calloutsAuto = style.callouts === 'auto';
	const resolved: ResolvedScreen[] = plan.screens.map((screen, i) => {
		const role = roleOf(i);
		const typo = typoFor(i);
		// Fabric never breaks inside a word: it widens the Textbox past its margins. Reject instead.
		for (const [what, text, size] of [
			['headline', screen.headline, typo.headlineSize],
			['subheadline', screen.subheadline ?? '', typo.subSize]
		] as const) {
			const long = overlongWords(text, typo.textWidth, (w) => estimateTextWidth(w, size, typo.font));
			if (long.length) {
				throw new Error(
					`screen ${i + 1}: the ${what} word "${long[0]}" is wider than the text box at the set size (it can't wrap inside a word) — shorten or split it`
				);
			}
		}
		const block = measureTextBlock(screen, typo);
		typo.textArea = Math.max(typo.textArea, block.height);
		const presentation: ComposePresentation = (COMPOSE_PRESENTATIONS as readonly string[]).includes(screen.presentation ?? '')
			? screen.presentation!
			: (COMPOSE_PRESENTATIONS as readonly string[]).includes(style.presentation ?? '')
				? style.presentation!
				: 'device';
		let layout: ComposeLayout = screen.layout && LAYOUTS[screen.layout] ? screen.layout : 'text-top';
		let bleed: BleedPreference = bleedPref;
		let rawTilt = typeof screen.tilt === 'number' ? screen.tilt : tiltScreens.has(i) ? (style.tilt ?? 0) : 0;
		if (role === 'hero' && heroCfg) {
			if (heroCfg.layout && LAYOUTS[heroCfg.layout]) layout = heroCfg.layout;
			bleed = (COMPOSE_BLEEDS as readonly string[]).includes(heroCfg.bleed ?? '') ? heroCfg.bleed! : bleedPref === 'none' ? 'none' : 'deep';
			if (typeof heroCfg.tilt === 'number') rawTilt = heroCfg.tilt;
		} else if (role === 'accent' && rhythm) {
			if (rhythm.treatment === 'text-bottom') layout = 'text-bottom';
			else if (bleedPref !== 'none') bleed = 'deep';
		}
		if (presentation === 'zoom' && layout === 'device-bleed') layout = 'text-top';
		const tilt = Number.isFinite(rawTilt) ? Math.max(-30, Math.min(30, rawTilt)) : 0;
		const fromPalette = screen.background ? null : paletteBackground(style.palette, i, role === 'hero' ? 0 : i);
		const background = screen.background ?? fromPalette ?? { type: 'solid', color: '#1F2937' };
		const backgroundFromStyle = !screen.background;
		const subjectKey =
			presentation === 'device'
				? screen.deviceId
				: presentation === 'frameless'
					? `shot:${screen.screenshot.width}x${screen.screenshot.height}`
					: 'card';
		const group = `${dims[i].W}x${dims[i].H}|${presentation}|${subjectKey}|${layout}|tilt:${tilt}|${role}|bleed:${bleed}`;
		// Callout: explicit crop, else auto (style.callouts / a `callout` accent) from the focus band.
		const explicitCallout = normalizeCrop(screen.callout);
		const accentCallout = role === 'accent' && rhythm?.treatment === 'callout';
		const wantsAuto = screen.callout !== false && !explicitCallout && (accentCallout || (calloutsAuto && role !== 'hero'));
		const calloutReq = presentation === 'zoom' ? undefined : (explicitCallout ?? (wantsAuto ? autoCallout(screen, accentCallout) : undefined));
		const mascot = (role === 'hero' ? (heroCfg?.mascot ?? screen.mascot) : screen.mascot) || undefined;
		if (mascot && !art.has(mascot.art)) throw new Error(`screen ${i + 1}: mascot.art "${mascot.art}" is not in plan.art`);
		return {
			index: i,
			plan: screen,
			W: dims[i].W,
			H: dims[i].H,
			layout,
			presentation,
			tilt,
			background,
			backgroundFromStyle,
			typo,
			block,
			group,
			role,
			bleed,
			badge: badgeOf(i),
			calloutReq,
			mascot
		};
	});

	// Requested straddlers: the first screen of a span, per `panorama.straddle` (never zoom cards).
	// They get their own group (their pose is judged after the seam shift).
	const straddleSpec = style.panorama?.straddle;
	const wantsStraddle = new Set(
		straddleSpec
			? spans.map((span) => span[0]).filter((i) => (Array.isArray(straddleSpec) ? straddleSpec.includes(i) : true) && resolved[i].presentation !== 'zoom')
			: []
	);
	for (const i of wantsStraddle) resolved[i].group += '|straddle';

	// Pass 2: one pose per group.
	const groups = new Map<string, ResolvedScreen[]>();
	for (const r of resolved) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
	const placements = new Map<number, Placement>();
	for (const members of groups.values()) {
		const asStraddle = members.every((m) => wantsStraddle.has(m.index));
		for (const [i, p] of placeGroup(members, members[0].bleed, warnings, asStraddle)) placements.set(i, p);
	}

	// Panorama: straddling devices (first screen of a span) cross into the next screen.
	const straddle = new Map<number, { cx: number; into: number }>();
	if (wantsStraddle.size) {
		for (const span of spans) {
			const i = span[0];
			if (!wantsStraddle.has(i)) continue;
			const r = resolved[i];
			const p = placements.get(i)!;
			if (r.presentation === 'zoom') continue;
			const W = r.W;
			// placeGroup found (or failed to find) a pose that straddles within the side / seam rules.
			const dx = p.straddleDx;
			const focus = normalizeFocus(r.plan.focus);
			if (dx == null) {
				warnings.push({
					screen: i,
					code: 'straddle-skipped',
					message: `screen ${i + 1}: device kept inside its screen — crossing the seam decisively (≥ ${Math.round(STRADDLE_MIN * 100)}% on the next screen) would put its focus band across it (or break the side margin)`
				});
				continue;
			}
			if (!focus) {
				warnings.push({
					screen: i,
					code: 'panorama-seam',
					message: `screen ${i + 1}: the device crosses the seam into screen ${i + 2} but has no \`focus\` band marked — mark one so the selling UI provably stays on screen ${i + 1}`
				});
			}
			straddle.set(i, { cx: W / 2 + dx, into: span[1] });
		}
	}

	// ---- Palette: ONE text colour per set (B2), WCAG ≥ 4.5 on every style-derived background. ----
	const paletteColors = (style.palette?.colors ?? []).filter(isHexColor);
	const tonal = style.palette?.mode === 'tonal' && paletteColors.length > 0;
	const brandBase = tonal ? paletteColors[0] : null;
	const accentColor = tonal ? (paletteColors[1] ?? null) : null;
	const candidates = textCandidates(brandBase);

	/** What a panorama span paints, given each screen's (possibly shifted) background. */
	const spanFill = (span: number[], bgOf: (r: ResolvedScreen) => BackgroundJSON): SpanFill => {
		const r0 = resolved[span[0]];
		const N = span.length;
		if (tonal && span.every((i) => resolved[i].backgroundFromStyle)) {
			// Tonal scene: one flowing ramp through every member's tone, corner to corner.
			const stops = span.map((i, k) => ({ offset: N > 1 ? k / (N - 1) : 0, color: sampleBackground(bgOf(resolved[i]), r0.W, r0.H, r0.W / 2, r0.H / 2) }));
			return { kind: 'linear', stops, coords: { x1: 0, y1: r0.H, x2: N * r0.W, y2: 0 } };
		}
		return spanFillFor(bgOf(r0), span[0], N, r0.W, r0.H);
	};
	const samplesOf = (r: ResolvedScreen, bgOf: (r: ResolvedScreen) => BackgroundJSON): string[] => {
		const out: string[] = [];
		const inSpan = spanOf.get(r.index);
		const fill = inSpan ? spanFill(inSpan.span, bgOf) : null;
		const bg = bgOf(r);
		for (let gx = 0; gx <= 4; gx++) {
			for (let gy = 0; gy <= 6; gy++) {
				const x = (gx / 4) * r.W;
				const y = (gy / 6) * r.H;
				out.push(fill ? samplePanorama(fill, inSpan!.k, r.W, x, y) : sampleBackground(bg, r.W, r.H, x, y));
			}
		}
		return out;
	};
	// M1: EVERY screen without an explicit headlineColor takes part in choosing the set colour.
	// Palette backgrounds (and spans whose fill comes from the palette) may be re-toned until it
	// passes; explicit backgrounds — including a panorama span whose fill is explicit — are sampled as
	// they are (never recoloured). When the set colour can't reach AA on such a FIXED unit, that unit
	// gets its own readable colour: a lone screen, or a whole span (one colour per span, so the scene
	// stays consistent) — metrics `textColorSource: "screen"`.
	const needsAuto = (r: ResolvedScreen) => !r.plan.headlineColor;
	/** Is this screen's visible background re-tonable (palette-derived)? A span follows its fill's source. */
	const shiftable = (r: ResolvedScreen) => {
		const inSpan = spanOf.get(r.index);
		return inSpan ? resolved[inSpan.span[0]].backgroundFromStyle : r.backgroundFromStyle;
	};
	const autoScreens = resolved.filter((r) => needsAuto(r) && shiftable(r));
	/** Fixed units: each explicit lone screen, and each span with an explicit fill (as one unit). */
	const fixedUnits: ResolvedScreen[][] = [];
	for (const r of resolved) {
		if (!needsAuto(r) || shiftable(r)) continue;
		const inSpan = spanOf.get(r.index);
		const unit = inSpan ? fixedUnits.find((u) => spanOf.get(u[0].index)?.span === inSpan.span) : undefined;
		if (unit) unit.push(r);
		else fixedUnits.push([r]);
	}
	const fixedSamples = fixedUnits.flat().flatMap((r) => samplesOf(r, (x) => x.background));
	let setText = HEX_TEXT_FALLBACK;
	if (autoScreens.length || fixedUnits.length) {
		const shifted = (target: string, shift: number) => (r: ResolvedScreen) => (r.backgroundFromStyle ? shiftBackground(r.background, target, shift) : r.background);
		// An explicit-only set keeps 0.4.0's white whenever white works (preferLight).
		const h = harmonize(
			autoScreens.length ? candidates : { dark: DARK_TEXT_FALLBACK, light: HEX_TEXT_FALLBACK },
			(target, shift) => autoScreens.flatMap((r) => samplesOf(r, shifted(target, shift))),
			fixedSamples,
			!autoScreens.length
		);
		setText = h.text;
		const target = h.text === candidates.dark ? '#FFFFFF' : '#000000';
		for (const r of resolved) if (r.backgroundFromStyle) r.background = shiftBackground(r.background, target, h.shift);
	}
	const bgNow = (r: ResolvedScreen) => r.background;
	/** Fixed units where the set colour can't reach AA: their own best colour (one per unit). */
	const ownText = new Map<number, string>();
	for (const unit of fixedUnits) {
		const samples = unit.flatMap((r) => samplesOf(r, bgNow));
		if (worstContrast(setText, samples) >= MIN_CONTRAST) continue;
		const options = [setText, candidates.dark, candidates.light, HEX_TEXT_FALLBACK, DARK_TEXT_FALLBACK].filter(isHexColor);
		const best = options.sort((a, b) => worstContrast(b, samples) - worstContrast(a, samples))[0];
		for (const r of unit) ownText.set(r.index, best);
	}
	const textColorOf = (r: ResolvedScreen) => r.plan.headlineColor ?? ownText.get(r.index) ?? setText;
	const textSourceOf = (r: ResolvedScreen): 'set' | 'screen' | 'plan' => (r.plan.headlineColor ? 'plan' : ownText.has(r.index) ? 'screen' : 'set');
	const contrastOf = new Map<number, number>();
	const warnedContrast = new Set<number>();
	for (const r of resolved) {
		const worst = worstContrast(textColorOf(r), samplesOf(r, bgNow));
		contrastOf.set(r.index, worst);
		if (!r.plan.headlineColor && worst < MIN_CONTRAST) {
			warnedContrast.add(r.index);
			warnings.push({
				screen: r.index,
				code: 'contrast-low',
				message: `screen ${r.index + 1}: text contrast is ${worst.toFixed(2)}:1 on its background (WCAG AA needs 4.5) — use style.palette or a darker/lighter background`
			});
		}
	}

	// The set's look: shadows tinted with the brand hue.
	const look: Look = {
		shadows: style.shadows !== false,
		shadowColor: brandBase
			? rgba(hslToHex({ h: hexToHsl(brandBase).h, s: Math.min(0.8, hexToHsl(brandBase).s), l: 0.14 }), 0.34)
			: SHADOW.color
	};

	// Span fills (validated up front, so a bad span background fails before any layer is built).
	const spanFills = new Map<number, SpanFill>();
	for (const span of spans) spanFills.set(span[0], spanFill(span, bgNow));
	/** Vertical band of a screen's reserved text block (with a small breathing gap). */
	const textBand = (r: ResolvedScreen) => {
		const top = r.layout === 'text-bottom' ? r.H - r.typo.margin - r.typo.textArea : r.typo.margin;
		const gap = ORB_TEXT_GAP * r.H;
		return { top: top - gap, bottom: top + r.typo.textArea + gap };
	};
	/**
	 * The orb on seam `seam` of a span: centred on ORB_Y·H with ORB_RADIUS·W, but moved/shrunk so it
	 * never overlaps either neighbour's text block (small landscape canvases); null when there's no room.
	 */
	const orbFor = (span: number[], seam: number): { cy: number; r: number } | null => {
		const a = resolved[span[seam - 1]];
		const b = resolved[span[seam]];
		const H = a.H;
		const blocks = [textBand(a), textBand(b)].sort((x, y) => x.top - y.top);
		const free: Array<{ lo: number; hi: number }> = [];
		let cursor = 0;
		for (const t of blocks) {
			if (t.top > cursor) free.push({ lo: cursor, hi: t.top });
			cursor = Math.max(cursor, t.bottom);
		}
		if (cursor < H) free.push({ lo: cursor, hi: H });
		const want = ORB_Y * H;
		const pick = free.find((f) => f.lo <= want && want <= f.hi) ?? free.sort((x, y) => y.hi - y.lo - (x.hi - x.lo))[0];
		if (!pick) return null;
		// The orb may run off the canvas edge (it's decoration), but never into a text block.
		const lo = pick.lo === 0 ? -Infinity : pick.lo;
		const hi = pick.hi === H ? Infinity : pick.hi;
		const r = Math.min(ORB_RADIUS * a.W, (hi - lo) / 2);
		if (!(r >= ORB_MIN_RADIUS * a.W)) return null;
		const cy = Math.min(Math.max(want, lo + r), hi - r);
		return { cy, r };
	};

	// ---- Pass 3a: per-screen geometry (text boxes, callouts) — needed by neighbours' mascots. ----
	interface Geo {
		r: ResolvedScreen;
		p: Placement;
		cx: number;
		areaTop: number;
		headlineTop: number;
		rects: TextRects;
		text: string;
		subText?: string;
		callout?: { rect: Rect; mag: number; crop: { x: number; y: number; w: number; h: number }; requested: { x: number; y: number; w: number; h: number }; scale: number; focusCover: number };
		focusCore?: Rect;
		mascot?: { rect: Rect; scale: number; flip: boolean; art: ComposeArt; seamPartner?: number; dx?: number };
	}
	const geos: Geo[] = resolved.map((r) => {
		const { W, H, typo, block } = r;
		const p = placements.get(r.index)!;
		const cx = straddle.get(r.index)?.cx ?? p.cx;
		const areaTop = r.layout === 'text-bottom' ? H - typo.margin - typo.textArea : typo.margin;
		const headlineTop = areaTop + typo.badgeRow;
		const lh = typo.headlineSize * HEADLINE_LINE_HEIGHT;
		const rects: TextRects = {
			headline: { left: (W - typo.textWidth) / 2, top: headlineTop, right: (W + typo.textWidth) / 2, bottom: headlineTop + block.headlineHeight },
			lines: block.headline.map((line, k) => {
				const w = Math.min(typo.textWidth, estimateTextWidth(line, typo.headlineSize, typo.font));
				return { left: (W - w) / 2, top: headlineTop + k * lh, right: (W + w) / 2, bottom: headlineTop + (k + 1) * lh };
			})
		};
		if (r.badge) {
			const pillH = typo.badgeFont * BADGE_HEIGHT;
			const pillW = Math.min(typo.textWidth, estimateTextWidth(r.badge, typo.badgeFont, typo.font) + 2 * BADGE_PAD_X * typo.badgeFont);
			rects.badge = { left: W / 2 - pillW / 2, top: areaTop, right: W / 2 + pillW / 2, bottom: areaTop + pillH };
		}
		if (block.sub.length) {
			const subTop = headlineTop + block.headlineHeight + block.gap;
			rects.sub = { left: rects.headline.left, top: subTop, right: rects.headline.right, bottom: subTop + block.subHeight };
		}
		const poly = focusPolygon(r, p, cx);
		let focusCore: Rect | undefined;
		if (poly) {
			const xs = poly.map((pt) => pt.x);
			const ys = poly.map((pt) => pt.y);
			const inset = MASCOT_FOCUS_INSET * W;
			focusCore = { left: Math.min(...xs) + inset, right: Math.max(...xs) - inset, top: Math.min(...ys), bottom: Math.max(...ys) };
		}
		const geo: Geo = { r, p, cx, areaTop, headlineTop, rects, text: block.headline.join('\n'), subText: block.sub.length ? block.sub.join('\n') : undefined, focusCore };
		// Callouts never ride a seam-crossing device.
		if (r.calloutReq && !straddle.has(r.index)) geo.callout = calloutGeometry(r, p, cx, rects, warnings) ?? undefined;
		return geo;
	});

	// ---- Pass 3b: mascots (placement avoids text, callouts and the focus band; may cross a seam). ----
	/** Mascots already placed that show on screen `idx` (its own, and seam halves crossing into it). */
	const mascotsOn = (idx: number): Rect[] =>
		geos.flatMap((o) => {
			if (!o.mascot) return [];
			if (o.r.index === idx) return [o.mascot.rect];
			if (o.mascot.seamPartner === idx) return [{ ...o.mascot.rect, left: o.mascot.rect.left + o.mascot.dx!, right: o.mascot.rect.right + o.mascot.dx! }];
			return [];
		});
	const obstaclesOf = (g: Geo): Rect[] => [
		...textRectList(g.rects).filter((x) => x !== g.rects.headline),
		...g.rects.lines,
		...(g.callout ? [g.callout.rect] : []),
		// Low (review): mascots never overlap each other, including a neighbour's seam half.
		...mascotsOn(g.r.index)
	];
	for (const g of geos) {
		const m = g.r.mascot;
		if (!m) continue;
		const a = art.get(m.art)!;
		const { W, H } = g.r;
		const inSpan = spanOf.get(g.r.index);
		const partner = inSpan ? (inSpan.k < inSpan.span.length - 1 ? inSpan.span[inSpan.k + 1] : inSpan.span[inSpan.k - 1]) : undefined;
		const seamX = inSpan ? (inSpan.k < inSpan.span.length - 1 ? W : 0) : undefined;
		const size = (Number.isFinite(m.size) && m.size! > 0 ? Math.min(0.5, m.size!) : g.r.role === 'hero' ? MASCOT_SIZE.hero : MASCOT_SIZE.screen) * W;
		const anchor: MascotAnchor = (MASCOT_ANCHORS as readonly string[]).includes(m.anchor ?? '') ? m.anchor! : 'headline';
		const order: MascotAnchor[] = [anchor, ...(['headline', 'device-top', 'device-side'] as MascotAnchor[]).filter((x) => x !== anchor)];
		const pad = MASCOT_PAD * W;
		const margin = MASCOT_MARGIN * W;
		const textRects = textRectList(g.rects);
		const textTop = Math.min(...textRects.map((t) => t.top));
		const textBottom = Math.max(...textRects.map((t) => t.bottom));
		const devBox = { left: g.cx - g.p.boxWidth / 2, right: g.cx + g.p.boxWidth / 2, top: g.p.cy - g.p.boxHeight / 2, bottom: g.p.cy + g.p.boxHeight / 2 };
		const textTopLayout = g.r.layout !== 'text-bottom';
		let placed: Geo['mascot'] | undefined;
		const fits = (rect: Rect, crossing: boolean): boolean => {
			const bounds: Rect = { left: margin, top: 0.012 * H, right: W - margin, bottom: H - 0.012 * H };
			if (crossing) {
				if (rect.top < bounds.top || rect.bottom > bounds.bottom) return false;
			} else if (!insideRect(rect, bounds)) return false;
			const blocks = (geo: Geo, dx: number) => {
				const shiftedRect = { ...rect, left: rect.left + dx, right: rect.right + dx };
				if (obstaclesOf(geo).some((o) => overlaps(shiftedRect, o, pad))) return true;
				return !!geo.focusCore && geo.focusCore.right > geo.focusCore.left && overlaps(shiftedRect, geo.focusCore);
			};
			if (blocks(g, 0)) return false;
			if (crossing && partner !== undefined) {
				const pg = geos[partner];
				// The half on the partner screen must clear ITS text / callout / focus too.
				if (blocks(pg, seamX === W ? -W : W)) return false;
			}
			return true;
		};
		const tryAt = (list: Array<[number, number]>, w: number, h: number, crossing: boolean) => {
			for (const [x, y] of list) {
				const rect = rectOf(x, y, w, h);
				if (fits(rect, crossing)) return rect;
			}
			return null;
		};
		for (const k of [1, 0.85, 0.7]) {
			const w = size * k;
			const h = (w * a.height) / a.width;
			for (const which of anchor === 'seam' ? (['seam', ...order.slice(1)] as MascotAnchor[]) : order) {
				let rect: Rect | null = null;
				let crossing = false;
				if (which === 'seam') {
					if (seamX === undefined) continue;
					crossing = true;
					rect = tryAt(
						[0.78, 0.68, 0.58, 0.88, 0.48, 0.38].map((f) => [seamX, f * H] as [number, number]),
						w,
						h,
						true
					);
				} else if (which === 'headline') {
					const L = g.rects.lines;
					const last = L[L.length - 1];
					const first = L[0];
					const nearY = textTopLayout ? textBottom + pad + h / 2 : textTop - pad - h / 2;
					rect = tryAt(
						[
							[last.right + pad + w / 2, (last.top + last.bottom) / 2],
							[last.left - pad - w / 2, (last.top + last.bottom) / 2],
							[first.right + pad + w / 2, (first.top + first.bottom) / 2],
							[first.left - pad - w / 2, (first.top + first.bottom) / 2],
							[W - margin - w / 2, nearY],
							[margin + w / 2, nearY]
						],
						w,
						h,
						false
					);
				} else if (which === 'device-top') {
					const y = textTopLayout ? Math.max(devBox.top + h * 0.1, textBottom + pad + h / 2) : Math.min(devBox.bottom - h * 0.1, textTop - pad - h / 2);
					rect = tryAt(
						[
							[Math.min(devBox.right - w * 0.35, W - margin - w / 2), y],
							[Math.max(devBox.left + w * 0.35, margin + w / 2), y]
						],
						w,
						h,
						false
					);
				} else {
					const ys = textTopLayout ? [0.8, 0.7, 0.6, 0.5] : [0.2, 0.3, 0.4, 0.5];
					rect = tryAt(
						ys.flatMap((f) => [
							[W - margin - w / 2, f * H] as [number, number],
							[margin + w / 2, f * H] as [number, number]
						]),
						w,
						h,
						false
					);
				}
				if (rect) {
					const cxm = (rect.left + rect.right) / 2;
					const faceLeft = cxm > W / 2; // face into the canvas
					const flip = typeof m.flip === 'boolean' ? m.flip : a.faces ? (faceLeft ? a.faces === 'right' : a.faces === 'left') : false;
					placed = { rect, scale: w / a.width, flip, art: a, ...(crossing ? { seamPartner: partner, dx: seamX === W ? -W : W } : {}) };
					break;
				}
			}
			if (placed) break;
		}
		if (placed) g.mascot = placed;
		else {
			warnings.push({
				screen: g.r.index,
				code: 'mascot-skipped',
				message: `screen ${g.r.index + 1}: no room for the mascot that clears the text, callout and focus band — try another anchor or a smaller size`
			});
		}
	}

	// ---- Pass 3c: layers per screen (bottom → top). ----
	const metrics: ComposeScreenMetrics[] = [];
	const decoration: Motif = (MOTIFS as readonly string[]).includes(style.panorama?.decoration ?? '') ? style.panorama!.decoration! : 'orbs';
	const darkText = setText === candidates.dark || (!brandBase && setText === DARK_TEXT_FALLBACK);
	const screens = geos.map((g) => {
		const { r, p, cx, rects } = g;
		const { W, H, typo, block, plan: screen } = r;
		const layers: LayerJSON[] = [];
		let background = r.background;

		// Panorama background + seam decoration (BOTTOM of the stack).
		const inSpan = spanOf.get(r.index);
		if (inSpan) {
			const { span, k } = inSpan;
			const N = span.length;
			// One continuous fill across the whole span, offset per screen.
			const fill = spanFills.get(span[0])!;
			background = { type: 'solid', color: fill.kind === 'solid' ? fill.color : colorAt(fill.stops, rampT(fill.coords, k * W + W / 2, H / 2)) };
			const bg = makeShapeLayer({
				shape: 'rectangle',
				left: (N * W) / 2 - k * W,
				top: H / 2,
				width: N * W,
				height: H,
				name: `Panorama background (${k + 1}/${N})`,
				locked: true
			});
			Object.assign(bg.fabricData as Record<string, unknown>, {
				fill:
					fill.kind === 'solid'
						? fill.color
						: {
								type: 'linear',
								gradientUnits: 'pixels',
								coords: { ...fill.coords },
								colorStops: fill.stops.map((s) => ({ offset: s.offset, color: s.color })),
								offsetX: 0,
								offsetY: 0
							},
				selectable: false,
				evented: false
			});
			layers.push(bg);
			if (decoration === 'orbs') {
				// A soft orb centred on each seam touching this screen, kept clear of both text blocks.
				for (let seam = 1; seam < N; seam++) {
					if (seam !== k && seam !== k + 1) continue;
					const orb = orbFor(span, seam);
					if (!orb) continue;
					layers.push(
						makeShapeLayer({
							shape: 'circle',
							left: seam * W - k * W,
							top: orb.cy,
							radius: orb.r,
							fill: 'rgba(255,255,255,0.14)',
							name: 'Panorama orb'
						})
					);
				}
			} else if (decoration !== 'none') {
				// H1: only the part of the span-wide motif this screen shows (O(N) per span, not O(N²)).
				const motif = motifPathForScreen(motifSubpaths(decoration, N * W, W, H), k, W, MOTIF_STROKE * W * 2);
				if (motif) layers.push(makeMotifLayer(motif, k, N, W, darkText, setText));
			}
		}

		// A device straddling in from the previous screen sits under this screen's own subject.
		for (const [from, s] of straddle) {
			if (s.into !== r.index) continue;
			const fr = resolved[from];
			const fp = placements.get(from)!;
			layers.push(makeSubjectLayer(fr, fp, look, s.cx - W, `${getDeviceFrame(fr.plan.deviceId)?.name ?? 'Screenshot'} (continued)`));
		}

		layers.push(makeSubjectLayer(r, p, look, cx));

		// Callout (magnified selling element) over the device, under the text.
		if (g.callout) layers.push(makeCalloutLayer(r, g.callout, look));

		// Mascots: this screen's own, plus a neighbour's half that crosses the seam onto this screen.
		if (g.mascot) layers.push(makeMascotLayer(g.mascot, 0, W, look, 'Mascot'));
		for (const other of geos) {
			if (other.mascot?.seamPartner === r.index) layers.push(makeMascotLayer(other.mascot, other.mascot.dx!, W, look, 'Mascot (continued)'));
		}

		// Text block: badge row → headline → subheadline, anchored to the reserved text area.
		const headlineColor = textColorOf(r);
		const hue = brandBase ?? accentColor;
		const subTint = hue && !screen.subheadlineColor && isHexColor(headlineColor) ? mixHex(headlineColor, hue, SUBHEADLINE_TINT) : null;
		// Dense samples right behind a text box (the whole-canvas grid can miss a gradient's contrast
		// minimum between its points).
		const textSamples = (rect: Rect) => {
			const out: string[] = [];
			for (let gx = 0; gx <= 8; gx++) {
				for (let gy = 0; gy <= 4; gy++) {
					const x = rect.left + ((rect.right - rect.left) * gx) / 8;
					const y = rect.top + ((rect.bottom - rect.top) * gy) / 4;
					out.push(inSpan ? samplePanorama(spanFills.get(inSpan.span[0])!, inSpan.k, W, x, y) : sampleBackground(r.background, W, H, x, y));
				}
			}
			return out;
		};
		const subSamples = rects.sub ? textSamples(rects.sub) : [];
		// The tint must clear AA with a margin (SUBHEADLINE_TINT_MIN), so it never lands at 4.49.
		const subColor =
			screen.subheadlineColor ??
			(subTint && worstContrast(subTint, [...samplesOf(r, bgNow), ...subSamples]) >= SUBHEADLINE_TINT_MIN ? subTint : headlineColor);
		// Warn (never silently ship sub-AA text) when the colours actually used fall short right behind
		// the headline or the subheadline — once per screen.
		if (!warnedContrast.has(r.index)) {
			const checks: Array<[string, string, string[]]> = [];
			if (!screen.headlineColor && isHexColor(headlineColor)) checks.push(['headline', headlineColor, textSamples(rects.headline)]);
			if (rects.sub && !screen.subheadlineColor && isHexColor(subColor)) checks.push(['subheadline', subColor, subSamples]);
			for (const [what, color, samples] of checks) {
				const worst = worstContrast(color, samples);
				if (worst < MIN_CONTRAST) {
					warnedContrast.add(r.index);
					warnings.push({
						screen: r.index,
						code: 'contrast-low',
						message: `screen ${r.index + 1}: ${what} contrast is ${worst.toFixed(2)}:1 behind the text (WCAG AA needs 4.5) — use style.palette or a darker/lighter background`
					});
					break;
				}
			}
		}
		if (r.badge && rects.badge) {
			const text = r.badge;
			if (text.length > BADGE_MAX_CHARS) {
				warnings.push({ screen: r.index, code: 'badge-long', message: `screen ${r.index + 1}: badge "${text}" is long — keep it to 1–3 words` });
			}
			const fontSize = typo.badgeFont;
			const pillH = fontSize * BADGE_HEIGHT;
			const pillW = rects.badge.right - rects.badge.left;
			const cy = g.areaTop + pillH / 2;
			// Tonal: a solid pill in the accent (or the text colour), label in whichever passes best on it.
			const pillSolid = tonal ? (accentColor ?? (isHexColor(headlineColor) ? headlineColor : null)) : null;
			const labelColor = pillSolid
				? [headlineColor, candidates.light, candidates.dark, '#FFFFFF', DARK_TEXT_FALLBACK]
						.filter(isHexColor)
						.sort((x, y) => contrastRatio(y, pillSolid) - contrastRatio(x, pillSolid))[0]
				: headlineColor;
			// The label must read at WCAG AA on the pill too (review Low): a solid pill is toned away
			// from the label until it does; a translucent one gets fainter (closer to the background,
			// on which the set colour already passes).
			let pillFill: string;
			if (pillSolid) {
				pillFill = pillSolid;
				// Toward whichever extreme contrasts more with the label (≥ 4.58:1 for any label colour).
				const away = contrastRatio(labelColor, '#000000') >= contrastRatio(labelColor, '#FFFFFF') ? '#000000' : '#FFFFFF';
				for (let t = 0.05; t <= 1 + 1e-9 && contrastRatio(labelColor, pillFill) < MIN_CONTRAST; t += 0.05) pillFill = mixHex(pillSolid, away, t);
			} else {
				const text = isHexColor(headlineColor) ? headlineColor : '#ffffff';
				const behind = inSpan ? samplePanorama(spanFills.get(inSpan.span[0])!, inSpan.k, W, W / 2, cy) : sampleBackground(r.background, W, H, W / 2, cy);
				let alpha = 0.18;
				while (alpha > 0.021 && contrastRatio(text, mixHex(behind, text, alpha)) < MIN_CONTRAST) alpha -= 0.02;
				pillFill = rgba(text, Math.round(alpha * 100) / 100);
			}
			const pill = makeShapeLayer({
				shape: 'rectangle',
				left: W / 2,
				top: cy,
				width: pillW,
				height: pillH,
				rx: pillH / 2,
				ry: pillH / 2,
				fill: pillFill,
				name: 'Badge'
			});
			const label = makeTextLayer({
				text,
				left: W / 2,
				top: cy,
				width: pillW,
				fontSize,
				fontFamily: font,
				fontWeight: '700',
				lineHeight: 1,
				fill: labelColor,
				textAlign: 'center',
				name: 'Badge text',
				templateRole: 'editable',
				templateKey: 'badge'
			});
			layers.push(pill, label);
		}

		// Center origin (editor convention): left/top are the box CENTER.
		layers.push(
			makeTextLayer({
				text: g.text,
				left: W / 2,
				top: g.headlineTop + block.headlineHeight / 2,
				width: typo.textWidth,
				fontSize: typo.headlineSize,
				fontFamily: font,
				fontWeight: '800',
				lineHeight: HEADLINE_LINE_HEIGHT,
				fill: headlineColor,
				textAlign: 'center',
				name: 'Headline',
				templateRole: 'editable',
				templateKey: 'headline'
			})
		);

		if (g.subText && rects.sub) {
			layers.push(
				makeTextLayer({
					text: g.subText,
					left: W / 2,
					top: rects.sub.top + block.subHeight / 2,
					width: typo.textWidth,
					fontSize: typo.subSize,
					fontFamily: font,
					fontWeight: SUBHEADLINE_WEIGHT,
					lineHeight: SUBHEADLINE_LINE_HEIGHT,
					fill: subColor,
					textAlign: 'center',
					name: 'Subheadline',
					templateRole: 'editable',
					templateKey: 'subheadline'
				})
			);
		}

		const top = p.cy - p.boxHeight / 2;
		const bottom = p.cy + p.boxHeight / 2;
		const overshoot = r.layout === 'text-bottom' ? -top : bottom - H;
		metrics.push({
			index: r.index,
			presentation: r.presentation,
			layout: r.layout,
			group: r.group,
			scale: p.scale,
			widthFraction: (p.subject.width * p.scale) / W,
			top: top / H,
			bottom: bottom / H,
			overshoot: overshoot / H,
			bleedFraction: p.boxHeight > 0 ? overshoot / p.boxHeight : 0,
			mode: overshoot > 0 ? 'bleed' : 'clear',
			tangent: inTangentZone(overshoot, p.boxHeight, H),
			headlineSize: typo.headlineSize / W,
			headlineTop: g.headlineTop / H,
			textBottom: (g.areaTop + typo.textArea) / H,
			tilt: p.angle,
			centerX: cx / W,
			role: r.role,
			headlineLines: block.headline,
			textColor: headlineColor,
			textColorSource: textSourceOf(r),
			contrast: contrastOf.get(r.index)!,
			...(g.callout ? { callout: { ...g.callout.rect, magnification: g.callout.mag, focusCover: g.callout.focusCover } } : {}),
			...(g.mascot ? { mascot: g.mascot.rect } : {})
		});

		return makeScreen({
			background,
			canvasWidth: W,
			canvasHeight: H,
			// Tag the device GROUP (multi-device) so a mixed plan lands as separate sidebar groups in
			// the editor instead of relying on frame inference. Absent ⇒ editor infers it.
			deviceClass: deviceClassForDeviceId(screen.deviceId) ?? undefined,
			layers
		});
	});

	// Copy + composition lint (warnings, never errors).
	resolved.forEach((r) => {
		const words = r.plan.headline.trim().split(/\s+/).filter(Boolean).length;
		const nn = r.index + 1;
		if (words > COPY_RULES.headlineMaxWords) {
			warnings.push({ screen: r.index, code: 'headline-words', message: `screen ${nn}: headline has ${words} words (aim for 3–5) — cut, don't shrink` });
		}
		if (r.block.headlineLines > COPY_RULES.headlineMaxLines) {
			warnings.push({
				screen: r.index,
				code: 'headline-lines',
				message: `screen ${nn}: headline wraps to ~${r.block.headlineLines} lines at the set size (max 2) — it grows the text area for EVERY screen`
			});
		}
		if (hasOrphan(r.block.headline)) {
			warnings.push({
				screen: r.index,
				code: 'headline-orphan',
				message: `screen ${nn}: the headline's last line is a single word ("${r.block.headline[r.block.headline.length - 1]}") — rephrase or place the break with \\n`
			});
		}
		if (r.block.subLines > COPY_RULES.subheadlineMaxLines) {
			warnings.push({
				screen: r.index,
				code: 'subheadline-lines',
				message: `screen ${nn}: subheadline wraps to ~${r.block.subLines} lines (max 1) — shorten it or drop it`
			});
		}
		const p = placements.get(r.index)!;
		if (p.zoom?.focusCropped) {
			warnings.push({ screen: r.index, code: 'zoom-focus-cropped', message: `screen ${nn}: the zoom card can't show the whole focus band — mark a tighter \`crop\`` });
		}
	});
	if (straddle.size > MAX_STRADDLES) {
		warnings.push({
			code: 'panorama-straddle-count',
			message: `${straddle.size} devices cross a seam — keep it to ${MAX_STRADDLES} per set (usually the hero) so the set stays calm`
		});
	}
	const tilted = resolved.filter((r) => r.tilt !== 0).length;
	if (tilted > COPY_RULES.maxTiltedScreens) {
		warnings.push({ code: 'tilt-count', message: `${tilted} screens are tilted — rotation is an accent: use it on at most ${COPY_RULES.maxTiltedScreens}` });
	}
	// Seam rule: nothing crossing a seam may touch a headline, and no focus band may cross a seam.
	for (const [from, s] of straddle) {
		const fr = resolved[from];
		const fp = placements.get(from)!;
		for (const [screenIdx, cx] of [
			[from, s.cx],
			[s.into, s.cx - fr.W]
		] as const) {
			const box = { left: cx - fp.boxWidth / 2, right: cx + fp.boxWidth / 2, top: fp.cy - fp.boxHeight / 2, bottom: fp.cy + fp.boxHeight / 2 };
			const t = geos[screenIdx].rects;
			if (textRectList(t).some((rect) => rectsOverlap(rect, box))) {
				warnings.push({ screen: screenIdx, code: 'panorama-seam', message: `screen ${screenIdx + 1}: the straddling device overlaps the text` });
			}
		}
		const poly = focusPolygon(fr, fp, s.cx);
		if (poly && Math.max(...poly.map((pt) => pt.x)) > fr.W) {
			warnings.push({ screen: from, code: 'panorama-seam', message: `screen ${from + 1}: the seam crosses the focus band` });
		}
	}

	metrics.sort((a, b) => a.index - b.index);
	return { template: makeTemplate({ name: plan.name, screens, tags: ['generated'] }), report: { warnings, screens: metrics } };
}

const DARK_TEXT_FALLBACK = '#111827';

/**
 * Where a callout card goes: the crop magnified 1.6–2.2× (less only when the card would not fit,
 * never below CALLOUT_MAG.floor), centred over the crop's own position on the device, clamped to the
 * side margins and to the free band between the text block and the far edge. Null (+ warning) when
 * it can't be shown large enough.
 */
function calloutGeometry(r: ResolvedScreen, p: Placement, cx: number, rects: TextRects, warnings: ComposeWarning[]) {
	const req = r.calloutReq!;
	const { W, H } = r;
	const shot = r.plan.screenshot;
	const requested = { x: req.x * shot.width, y: req.y * shot.height, w: req.w * shot.width, h: req.h * shot.height };
	const scr = p.subject.screen;
	// Canvas px per screenshot px as the editor fits it into the screen bounds (frameless: the image).
	const screenScale = (p.scale * scr.width) / shot.width;
	// Vertical band the card must fit in — computed before padding since it only depends on the text
	// layout, not the crop, and the padding estimate below needs it too (the same vertical fit cap
	// applies to both).
	const texts = textRectList(rects);
	const gap = CALLOUT_TEXT_GAP * H;
	const [lo, hi] =
		r.layout === 'text-bottom'
			? [CALLOUT_EDGE * H, Math.min(...texts.map((t) => t.top)) - gap]
			: [Math.max(...texts.map((t) => t.bottom)) + gap, H * (1 - CALLOUT_EDGE)];
	// Pad the requested crop on sides that have room inside the screenshot, so its own corners land
	// inside the rounded clip mask (`makeCalloutLayer`) instead of being cut off there. `pad` is sized
	// from a PRELIMINARY magnification: the same formula AND the same fit caps (side margins, vertical
	// room) used below, run on the unpadded crop — since the final mag depends on the padded crop's own
	// size, this is a deterministic chicken-and-egg break, not the exact final mag. The placement
	// search below can still shrink the final mag further (retrying smaller sizes when every position
	// hides too much of the focus band), so `makeCalloutLayer` also hard-caps the mask's own corner
	// radius as a backstop — the padding here just keeps that cap from binding in the common case.
	const baseWReq = requested.w * screenScale;
	const baseHReq = requested.h * screenScale;
	let prelimMag = Math.min(CALLOUT_MAG.max, Math.max(CALLOUT_MAG.min, (CALLOUT_TARGET_WIDTH * W) / baseWReq));
	prelimMag = Math.min(prelimMag, ((1 - 2 * CALLOUT_MARGIN) * W) / baseWReq, (hi - lo) / baseHReq);
	// Guard against a degenerate (non-positive) estimate — e.g. no vertical room at all — blowing up
	// `pad`; the real computation below bails out (`callout-skipped`) in that same case anyway, so the
	// crop's exact shape no longer matters once that happens.
	prelimMag = Math.max(prelimMag, 1e-6);
	const pad = (CALLOUT_CORNER_PAD * CALLOUT_RADIUS * W) / (screenScale * prelimMag);
	const padX0 = Math.max(0, requested.x - pad);
	const padY0 = Math.max(0, requested.y - pad);
	const crop = {
		x: padX0,
		y: padY0,
		w: Math.min(shot.width, requested.x + requested.w + pad) - padX0,
		h: Math.min(shot.height, requested.y + requested.h + pad) - padY0
	};
	const centre = subjectPointToCanvas(
		p.subject,
		{ x: scr.x + ((crop.x + crop.w / 2) / shot.width) * scr.width, y: scr.y + ((crop.y + crop.h / 2) / shot.height) * scr.height },
		{ cx, cy: p.cy, scale: p.scale, angle: p.angle }
	);
	const baseW = crop.w * screenScale;
	const baseH = crop.h * screenScale;
	let mag = Math.min(CALLOUT_MAG.max, Math.max(CALLOUT_MAG.min, (CALLOUT_TARGET_WIDTH * W) / baseW));
	mag = Math.min(mag, ((1 - 2 * CALLOUT_MARGIN) * W) / baseW, (hi - lo) / baseH);
	if (!(mag >= CALLOUT_MAG.floor)) {
		warnings.push({
			screen: r.index,
			code: 'callout-skipped',
			message: `screen ${r.index + 1}: the callout crop is too large to magnify (${mag.toFixed(2)}× fits) — mark a smaller \`callout\` region`
		});
		return null;
	}
	// M2: the focus band (canvas bbox, clipped to the canvas) and the callout's own source slice.
	const pose = { cx, cy: p.cy, scale: p.scale, angle: p.angle };
	const bboxOf = (pts: Array<{ x: number; y: number }>): Rect => ({
		left: Math.min(...pts.map((q) => q.x)),
		right: Math.max(...pts.map((q) => q.x)),
		top: Math.min(...pts.map((q) => q.y)),
		bottom: Math.max(...pts.map((q) => q.y))
	});
	const poly = focusPolygon(r, p, cx);
	const focusRect = poly ? bboxOf(poly) : null;
	if (focusRect) Object.assign(focusRect, { left: Math.max(0, focusRect.left), right: Math.min(W, focusRect.right), top: Math.max(0, focusRect.top), bottom: Math.min(H, focusRect.bottom) });
	const toCanvas = (fx: number, fy: number) => subjectPointToCanvas(p.subject, { x: scr.x + fx * scr.width, y: scr.y + fy * scr.height }, pose);
	const source = bboxOf([toCanvas(req.x, req.y), toCanvas(req.x + req.w, req.y), toCanvas(req.x + req.w, req.y + req.h), toCanvas(req.x, req.y + req.h)]);
	const cover = (card: Rect) => (focusRect ? focusCoverage(card, focusRect, source) : 0);
	const m = CALLOUT_MARGIN * W;
	// Candidates, best first: the largest magnification, then the position closest to the source
	// (centred on it, then moved up/down, then pushed out to a side edge to break out of the device).
	for (let k = mag; k >= CALLOUT_MAG.floor - 1e-9; k = k > CALLOUT_MAG.floor ? Math.max(CALLOUT_MAG.floor, k * 0.92) : k - 1) {
		const w = baseW * k;
		const h = baseH * k;
		const xs = [Math.min(Math.max(centre.x, m + w / 2), W - m - w / 2), m + w / 2, W - m - w / 2];
		const ys: number[] = [];
		const y0 = Math.min(Math.max(centre.y, lo + h / 2), hi - h / 2);
		for (let t = 0; t <= 24; t++) ys.push(lo + h / 2 + ((hi - lo - h) * t) / 24);
		let bestRect: Rect | null = null;
		let bestDist = Infinity;
		for (const x of xs) {
			for (const y of [y0, ...ys]) {
				const rect = rectOf(x, y, w, h);
				if (cover(rect) > CALLOUT_MAX_FOCUS_COVER + 1e-9) continue;
				const dist = Math.hypot((x - centre.x) / W, (y - centre.y) / H);
				if (dist < bestDist - 1e-9) {
					bestDist = dist;
					bestRect = rect;
				}
			}
		}
		if (bestRect) return { rect: bestRect, mag: k, crop, requested, scale: screenScale * k, focusCover: cover(bestRect) };
		if (k <= CALLOUT_MAG.floor) break;
	}
	warnings.push({
		screen: r.index,
		code: 'callout-skipped',
		message: `screen ${r.index + 1}: no callout position hides less than ${Math.round(CALLOUT_MAX_FOCUS_COVER * 100)}% of the rest of the focus band — mark a smaller \`callout\` or a tighter \`focus\``
	});
	return null;
}

function makeCalloutLayer(r: ResolvedScreen, c: NonNullable<ReturnType<typeof calloutGeometry>>, look: Look): LayerJSON {
	const id = generateLayerId();
	// Hard guarantee, independent of how `calloutGeometry`'s padding estimate turned out (it's only a
	// preliminary-magnification guess — the placement search can shrink the final mag further): the
	// mask's corner radius can never clip the REQUESTED crop's own corners. On each side that had room
	// to pad (not clamped flush to the screenshot edge — a clamped side had no padding and was always
	// going to clip there, mask or no mask), the actual padding applied is the gap between `crop` and
	// `requested`. The geometric minimum margin to keep a corner inside a rounded corner of local
	// radius `rx` is `(1 − 1/√2) · rx`, so `rx` is capped at the smallest such padding ÷ (1 − 1/√2) —
	// converted back to a canvas-unit radius via `c.scale`. If every side is clamped (the crop already
	// spans the screenshot), there's no padding to guarantee anything from, so the normal radius stands.
	const shot = r.plan.screenshot;
	const EPS = 1e-6;
	const pads: number[] = [];
	if (c.crop.x > EPS) pads.push(c.requested.x - c.crop.x);
	if (c.crop.y > EPS) pads.push(c.requested.y - c.crop.y);
	if (c.crop.x + c.crop.w < shot.width - EPS) pads.push(c.crop.x + c.crop.w - (c.requested.x + c.requested.w));
	if (c.crop.y + c.crop.h < shot.height - EPS) pads.push(c.crop.y + c.crop.h - (c.requested.y + c.requested.h));
	const CORNER_INSET = 1 - 1 / Math.SQRT2; // ≈0.293 — geometric minimum margin to keep a corner inside a rounded corner of radius rx
	const radius = pads.length ? Math.min(CALLOUT_RADIUS * r.W, (Math.min(...pads) / CORNER_INSET) * c.scale) : CALLOUT_RADIUS * r.W;
	const fabricData: Record<string, unknown> = {
		type: 'image',
		src: r.plan.screenshot.url,
		crossOrigin: 'anonymous',
		left: (c.rect.left + c.rect.right) / 2,
		top: (c.rect.top + c.rect.bottom) / 2,
		width: c.crop.w,
		height: c.crop.h,
		cropX: c.crop.x,
		cropY: c.crop.y,
		scaleX: c.scale,
		scaleY: c.scale,
		originX: 'center',
		originY: 'center',
		clipPath: {
			type: 'Rect',
			left: 0,
			top: 0,
			width: c.crop.w,
			height: c.crop.h,
			rx: radius / c.scale,
			ry: radius / c.scale,
			originX: 'center',
			originY: 'center'
		},
		imageCornerRadius: radius,
		layerId: id,
		layerType: 'image'
	};
	if (look.shadows) fabricData.shadow = shadowFor(r.W, c.scale, look, CALLOUT_SHADOW);
	return { id, name: 'Callout', type: 'image', visible: true, locked: false, fabricData };
}

function makeMascotLayer(m: { rect: Rect; scale: number; flip: boolean; art: ComposeArt }, dx: number, W: number, look: Look, name: string): LayerJSON {
	const id = generateLayerId();
	const fabricData: Record<string, unknown> = {
		type: 'image',
		src: m.art.url,
		crossOrigin: 'anonymous',
		left: (m.rect.left + m.rect.right) / 2 + dx,
		top: (m.rect.top + m.rect.bottom) / 2,
		width: m.art.width,
		height: m.art.height,
		scaleX: m.scale,
		scaleY: m.scale,
		originX: 'center',
		originY: 'center',
		layerId: id,
		layerType: 'image'
	};
	if (m.flip) fabricData.flipX = true;
	if (look.shadows) fabricData.shadow = shadowFor(W, m.scale, look, MASCOT_SHADOW);
	return { id, name, type: 'image', visible: true, locked: false, fabricData };
}

const MOTIF_STROKE = 0.008; // × W

/**
 * Span screen `k`'s part of the motif (already in screen coordinates — see `motifPathForScreen`).
 * Fabric centres a Path on its bbox, so `left`/`top` = the bbox centre.
 */
function makeMotifLayer(motif: { path: PathCommand[]; bbox: Rect }, k: number, N: number, W: number, darkText: boolean, text: string): LayerJSON {
	const id = generateLayerId();
	const stroke = darkText ? 'rgba(255,255,255,0.42)' : rgba(isHexColor(text) ? text : '#FFFFFF', 0.16);
	return {
		id,
		name: `Panorama motif (${k + 1}/${N})`,
		type: 'shape',
		visible: true,
		locked: true,
		fabricData: {
			type: 'Path',
			path: motif.path.map((c) => [...c]),
			left: (motif.bbox.left + motif.bbox.right) / 2,
			top: (motif.bbox.top + motif.bbox.bottom) / 2,
			originX: 'center',
			originY: 'center',
			fill: 'rgba(0,0,0,0)',
			stroke,
			strokeWidth: MOTIF_STROKE * W,
			strokeLineJoin: 'round',
			selectable: false,
			evented: false,
			layerId: id,
			layerType: 'shape',
			shapeType: 'path'
		}
	};
}

/**
 * Deterministically assemble a Template from a plan (see `composeSet` for the set-wide layout rules
 * and the lint report). Text layers are marked editable so the user can tweak them in the editor.
 * Claude decides the plan (benefit, copy, device, palette, layout, style); this turns it into valid DSL.
 */
export function composeTemplate(plan: ComposePlan): Template {
	return composeSet(plan).template;
}
