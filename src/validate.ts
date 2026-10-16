import type { LayerJSON, ScreenLayersJSON, Template } from './types';
import { CURRENT_SCHEMA_VERSION } from './types';
import { getDeviceFrame } from './device-frames';

const LAYER_TYPES = ['background', 'text', 'image', 'device', 'shape'];

/** Check if a value is a valid LayerJSON. */
export function isValidLayerJSON(data: unknown): data is LayerJSON {
	if (!data || typeof data !== 'object') return false;
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.id === 'string' &&
		typeof obj.name === 'string' &&
		typeof obj.type === 'string' &&
		LAYER_TYPES.includes(obj.type as string) &&
		typeof obj.visible === 'boolean' &&
		typeof obj.locked === 'boolean'
	);
}

/** Check if a value is a valid ScreenLayersJSON. */
export function isValidScreenLayersJSON(data: unknown): data is ScreenLayersJSON {
	if (!data || typeof data !== 'object') return false;
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.schemaVersion === 'number' &&
		Array.isArray(obj.layers) &&
		obj.layers.every(isValidLayerJSON)
	);
}

/** Check if a value is a valid Template. */
export function isValidTemplate(data: unknown): data is Template {
	if (!data || typeof data !== 'object') return false;
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.id === 'string' &&
		typeof obj.name === 'string' &&
		typeof obj.thumbnail === 'string' &&
		Array.isArray(obj.tags) &&
		typeof obj.version === 'string' &&
		Array.isArray(obj.screens) &&
		obj.screens.every(isValidScreenLayersJSON)
	);
}

/** Migrate a ScreenLayersJSON from older schema versions to the current one. */
export function migrateScreenLayersJSON(json: ScreenLayersJSON): ScreenLayersJSON {
	let migrated = { ...json };

	// v1 -> v2: convert gradient `colors` array to `colorStops` with offsets.
	if (migrated.schemaVersion < 2) {
		const gradient = migrated.background?.gradient;
		const hasColors = gradient?.colors && gradient.colors.length > 0;
		const hasColorStops = gradient?.colorStops && gradient.colorStops.length > 0;

		if (hasColors && !hasColorStops) {
			const colors = gradient!.colors!;
			migrated = {
				...migrated,
				schemaVersion: 2,
				background: {
					...migrated.background!,
					gradient: {
						...gradient!,
						colorStops: colors.map((color, index) => ({
							offset: colors.length > 1 ? index / (colors.length - 1) : 0,
							color
						}))
					}
				}
			};
			delete migrated.background!.gradient!.colors;
		} else {
			migrated.schemaVersion = 2;
		}
	}

	return migrated;
}

/** Generate a unique layer id. */
export function generateLayerId(): string {
	return `layer-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * The only screenshot URL form a device layer's `fabricData.screenshot.src` may carry: a
 * same-origin, root-relative reference to the user's uploaded asset (`/api/screenshots/<id>/raw`,
 * which the Worker serves owner-only from private R2). Rejects external, protocol-relative,
 * `data:`/`javascript:` and path-traversal URLs, so a handoff can't make the editor fetch
 * arbitrary third-party images.
 */
export const UPLOADED_SCREENSHOT_SRC = /^\/api\/screenshots\/[A-Za-z0-9_-]{1,128}\/raw$/;

export function isUploadedScreenshotSrc(src: unknown): src is string {
	return typeof src === 'string' && UPLOADED_SCREENSHOT_SRC.test(src);
}

/**
 * A device layer's own `fabricData.src` — the frame PNG/WebP the editor serves from `static/devices/`
 * (see `DeviceFrame.frameAsset`; the built-in templates still reference legacy `.png` names).
 * Single path segment, no dots besides the extension, so no traversal.
 */
export const DEVICE_FRAME_SRC = /^\/devices\/[a-z0-9][a-z0-9-]*\.(?:webp|png)$/;

export function isDeviceFrameSrc(src: unknown): src is string {
	return typeof src === 'string' && DEVICE_FRAME_SRC.test(src);
}

const SCREENSHOT_ROTATIONS = [0, 90, 180, 270];
const SCREENSHOT_KEYS = new Set(['src', 'width', 'height', 'rotation']);

/** Problems with a device layer's `fabricData.screenshot` (see `DeviceScreenshotJSON`); empty ⇒ valid. */
export function validateDeviceScreenshot(value: unknown, at = 'screenshot'): string[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at} must be an object`];
	const errors: string[] = [];
	const shot = value as Record<string, unknown>;
	for (const key of Object.keys(shot)) {
		if (!SCREENSHOT_KEYS.has(key)) errors.push(`${at}.${key} is not allowed`);
	}
	if (!isUploadedScreenshotSrc(shot.src)) {
		errors.push(`${at}.src must be an uploaded screenshot URL (/api/screenshots/<id>/raw)`);
	}
	for (const dim of ['width', 'height'] as const) {
		const n = shot[dim];
		if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
			errors.push(`${at}.${dim} must be a positive number`);
		}
	}
	if (shot.rotation !== undefined && !SCREENSHOT_ROTATIONS.includes(shot.rotation as number)) {
		errors.push(`${at}.rotation must be one of 0, 90, 180, 270`);
	}
	return errors;
}

/**
 * Editor-internal Fabric properties that drive loading/placement at runtime. Never legitimate in a
 * handoff: e.g. `pendingScreenshot` makes the editor (re)load an image URL as a frame's screenshot,
 * which would bypass the `screenshot.src` rules below.
 */
export const EDITOR_INTERNAL_PROPS = [
	'pendingScreenshot',
	'_lastFrameScaleX',
	'_lastFrameScaleY',
	'_userScale',
	'_userOffsetX',
	'_userOffsetY'
] as const;

/**
 * Keys that JSON.parse keeps as OWN properties but that change meaning once copied/enlivened
 * (`__proto__` smuggles properties past `in`/dot checks; `constructor` breaks Fabric's enliven).
 */
export const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/** Problems for every forbidden key anywhere inside `value` (own keys only, depth-capped). */
export function findForbiddenKeys(value: unknown, at: string, depth = 0): string[] {
	if (depth > 32 || !value || typeof value !== 'object') return [];
	const errors: string[] = [];
	const entries = Array.isArray(value)
		? value.map((v, k) => [`[${k}]`, v] as const)
		: Object.keys(value).map((k) => [`.${k}`, (value as Record<string, unknown>)[k]] as const);
	for (const [suffix, v] of entries) {
		const key = suffix.startsWith('.') ? suffix.slice(1) : null;
		if (key !== null && (FORBIDDEN_KEYS as readonly string[]).includes(key)) {
			errors.push(`${at}${suffix} is not allowed`);
			continue;
		}
		errors.push(...findForbiddenKeys(v, `${at}${suffix}`, depth + 1));
	}
	return errors;
}

/** Any `src` / `source` (image layers, pattern fills, group children, clip paths…) must be one of these. */
function isAllowedImageRef(value: unknown): boolean {
	return isUploadedScreenshotSrc(value) || isDeviceFrameSrc(value);
}

/** Collect problems with every `src`/`source` value anywhere inside `value`. */
function checkImageRefs(value: unknown, at: string, errors: string[], depth = 0): void {
	if (depth > 32) {
		errors.push(`${at} is nested too deeply`);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((v, k) => checkImageRefs(v, `${at}[${k}]`, errors, depth + 1));
		return;
	}
	if (!value || typeof value !== 'object') return;
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if ((key === 'src' || key === 'source') && !isAllowedImageRef(v)) {
			errors.push(
				`${at}.${key} must be an uploaded screenshot (/api/screenshots/<id>/raw) or a device frame asset (/devices/<name>.webp|png)`
			);
		} else if (v && typeof v === 'object') {
			checkImageRefs(v, `${at}.${key}`, errors, depth + 1);
		}
	}
}

const DEVICE_SHADOW_KEYS = new Set(['color', 'blur', 'offsetX', 'offsetY']);

/**
 * Problems with a device layer's `fabricData.deviceShadow` (shot-dsl 0.5.0): `{ color, blur, offsetX,
 * offsetY }` in canvas units — a colour string (≤ 64 chars) and finite numbers, blur in
 * [0, canvasWidth] and offsets within ±canvasWidth (the composer emits ~7.5% / 3% of W).
 */
export function validateDeviceShadow(value: unknown, canvasWidth: number, at = 'deviceShadow'): string[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at} must be an object`];
	const errors: string[] = [];
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!DEVICE_SHADOW_KEYS.has(key)) errors.push(`${at}.${key} is not allowed`);
	if (typeof v.color !== 'string' || !v.color || v.color.length > 64) errors.push(`${at}.color must be a colour string (≤ 64 chars)`);
	const limit = canvasWidth > 0 && Number.isFinite(canvasWidth) ? canvasWidth : 4096;
	const num = (key: string, min: number) => {
		const n = v[key];
		if (n === undefined && key !== 'blur') return;
		if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > limit) errors.push(`${at}.${key} must be a number from ${min} to ${limit}`);
	};
	num('blur', 0);
	num('offsetX', -limit);
	num('offsetY', -limit);
	return errors;
}

/** Per-layer fabricData rules for handoffs (see validateTemplate). */
function validateLayerFabricData(
	layer: LayerJSON,
	fd: Record<string, unknown>,
	at: string,
	frameIds: Set<string>,
	canvasWidth = 0
): string[] {
	const errors: string[] = [];
	const fdAt = `${at}.fabricData`;

	for (const prop of EDITOR_INTERNAL_PROPS) {
		if (prop in fd) errors.push(`${fdAt}.${prop} is editor-internal and not allowed`);
	}

	// Frame role/metadata only on device layers; screenshot role only on a legacy image layer.
	const isLegacyScreenshot = fd.layerRole === 'screenshot';
	if (layer.type === 'device') {
		if (fd.layerRole !== undefined && fd.layerRole !== 'frame') {
			errors.push(`${fdAt}.layerRole must be "frame" on a device layer`);
		}
		if (typeof fd.deviceId !== 'string' || !getDeviceFrame(fd.deviceId)) {
			errors.push(`${fdAt}.deviceId must be a known device id`);
		}
		if (!isDeviceFrameSrc(fd.src)) {
			errors.push(`${fdAt}.src must be a device frame asset (/devices/<name>.webp|png)`);
		}
		if (typeof fd.deviceFrameId === 'string' && fd.deviceFrameId) {
			if (frameIds.has(fd.deviceFrameId)) {
				errors.push(`${fdAt}.deviceFrameId "${fd.deviceFrameId}" is duplicated in this screen`);
			}
			frameIds.add(fd.deviceFrameId);
		}
	} else if (isLegacyScreenshot) {
		// Legacy (≤0.2.0) separate screenshot layer: still accepted, but only in its real shape and
		// held to the same uploaded-asset src rule as the 0.3.0 property.
		if (layer.type !== 'image' || typeof fd.type !== 'string' || fd.type.toLowerCase() !== 'image') {
			errors.push(`${fdAt}.layerRole "screenshot" is only allowed on image layers`);
		}
		if (!isUploadedScreenshotSrc(fd.src)) {
			errors.push(`${fdAt}.src must be an uploaded screenshot URL (/api/screenshots/<id>/raw)`);
		}
		if (fd.deviceId !== undefined && (typeof fd.deviceId !== 'string' || !getDeviceFrame(fd.deviceId))) {
			errors.push(`${fdAt}.deviceId must be a known device id`);
		}
	} else {
		if (fd.layerRole !== undefined) errors.push(`${fdAt}.layerRole is only allowed on device / legacy screenshot layers`);
		for (const key of ['deviceFrameId', 'deviceId', 'deviceScale']) {
			if (fd[key] !== undefined) errors.push(`${fdAt}.${key} is only allowed on device / legacy screenshot layers`);
		}
		if (fd.layerType === 'deviceFrame') errors.push(`${fdAt}.layerType "deviceFrame" is only allowed on device layers`);
	}

	// Device drop shadow (0.5.0).
	if (fd.deviceShadow !== undefined) {
		if (layer.type !== 'device') errors.push(`${fdAt}.deviceShadow is only allowed on device layers`);
		errors.push(...validateDeviceShadow(fd.deviceShadow, canvasWidth, `${fdAt}.deviceShadow`));
	}

	// Device-owned screenshot (0.3.0+).
	if (fd.screenshot !== undefined) {
		if (layer.type !== 'device') errors.push(`${fdAt}.screenshot is only allowed on device layers`);
		errors.push(...validateDeviceScreenshot(fd.screenshot, `${fdAt}.screenshot`));
	}

	// Every other image reference (image layers, pattern fills, nested objects): same-origin
	// uploaded screenshots or device frame assets only. (Top-level device/screenshot srcs were
	// checked above with their stricter rule; skip them here to avoid duplicate messages.)
	const { src: _src, screenshot: _screenshot, ...rest } = fd;
	void _screenshot;
	if (layer.type !== 'device' && !isLegacyScreenshot && _src !== undefined && !isAllowedImageRef(_src)) {
		errors.push(
			`${fdAt}.src must be an uploaded screenshot (/api/screenshots/<id>/raw) or a device frame asset (/devices/<name>.webp|png)`
		);
	}
	checkImageRefs(rest, fdAt, errors);

	return errors;
}

/**
 * The handoff API's size cap: `POST /api/handoffs` rejects a body over this many bytes (413). The
 * body is `JSON.stringify({ template })`. Producers (the skill's `lint` / `publish`) check
 * `handoffBytes` against it before any network call.
 */
export const MAX_HANDOFF_BYTES = 256 * 1024;

/** UTF-8 size of the handoff request body for `template` (what the server measures). */
export function handoffBytes(template: unknown): number {
	return new TextEncoder().encode(JSON.stringify({ template })).length;
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Strict, error-reporting validation for a Template (used by the Worker on
 * handoff upload and by the skill's composer before sending). Unlike the boolean
 * `isValidTemplate`, this returns a list of human-readable problems.
 */
export function validateTemplate(data: unknown): ValidationResult {
	const errors: string[] = [];
	if (!data || typeof data !== 'object') {
		return { valid: false, errors: ['Template must be an object'] };
	}
	const t = data as Record<string, unknown>;

	if (typeof t.id !== 'string' || !t.id) errors.push('id must be a non-empty string');
	if (typeof t.name !== 'string' || !t.name) errors.push('name must be a non-empty string');

	if (!Array.isArray(t.screens) || t.screens.length === 0) {
		errors.push('screens must be a non-empty array');
	} else {
		t.screens.forEach((screen, i) => {
			if (!isValidScreenLayersJSON(screen)) {
				errors.push(`screens[${i}] is not a valid screen`);
				return;
			}
			const s = screen as ScreenLayersJSON;
			if (s.schemaVersion > CURRENT_SCHEMA_VERSION) {
				errors.push(`screens[${i}] has unsupported schemaVersion ${s.schemaVersion}`);
			}
			const layerIds = new Set<string>();
			const frameIds = new Set<string>();
			s.layers.forEach((layer, j) => {
				const at = `screens[${i}].layers[${j}]`;
				if (!isValidLayerJSON(layer)) errors.push(`${at} is invalid`);
				errors.push(...findForbiddenKeys(layer, at));
				if (layerIds.has(layer.id)) errors.push(`${at}.id "${layer.id}" is duplicated in this screen`);
				layerIds.add(layer.id);

				const fd = layer.fabricData as Record<string, unknown> | null;
				if (!fd || typeof fd !== 'object') return;
				errors.push(...validateLayerFabricData(layer, fd, at, frameIds, s.canvasWidth ?? 0));
			});
		});
	}

	return { valid: errors.length === 0, errors };
}
