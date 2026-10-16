/**
 * App Shot Editor layout DSL — pure data types shared by the editor, the
 * Cloudflare Worker (handoff validation), and the skill's composer.
 *
 * No Fabric.js / runtime dependencies live here: `fabricData` is an opaque JSON
 * object that the editor enlivens into a Fabric object at load time. Keeping this
 * module dependency-free is what lets the Worker and the standalone skill bundle
 * import + validate the same DSL without pulling in the editor.
 */

export type LayerType = 'background' | 'text' | 'image' | 'device' | 'shape';

export type TemplateRole = 'placeholder' | 'editable' | 'fixed';

/** Current ScreenLayersJSON schema version. */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Screenshot carried BY a device-frame layer (`type: 'device'`), at `fabricData.screenshot`.
 *
 * Since shot-dsl 0.3.0 a device mockup is ONE layer: the frame, with its screenshot as a property —
 * mirroring the editor, where a frame's screenshot is owned by the frame (it is not a panel layer).
 * On import the editor places the image under the frame and clips it to the screen area with the
 * same code path it uses when a user drops a screenshot onto a frame, so producers never compute
 * screenshot geometry or clip paths themselves.
 *
 * Legacy (≤ 0.2.0) templates instead emitted a separate `type: 'image'` layer with
 * `fabricData.layerRole === 'screenshot'` + a `deviceFrameId` matching its frame, placed directly
 * below the frame. `validateTemplate` still accepts that shape and the editor converts it on import.
 */
export interface DeviceScreenshotJSON {
	/**
	 * Image URL. In handoffs this must be the uploaded-asset form `/api/screenshots/<id>/raw`
	 * (see `isUploadedScreenshotSrc`) — external / `data:` / protocol-relative URLs are rejected.
	 */
	src: string;
	/** Natural pixel size of the screenshot. */
	width: number;
	height: number;
	/** Clockwise rotation inside the frame, in degrees (0 | 90 | 180 | 270). Default 0. */
	rotation?: number;
}

/**
 * JSON representation of a single layer for persistence + handoff.
 *
 * Order convention: in a DSL `ScreenLayersJSON.layers` array (templates, handoffs) layers are listed
 * BOTTOM → TOP — index 0 is painted first (canvas add order), the last entry is frontmost. E.g. a
 * composed screen is `[device, headline, subheadline]`; the built-in templates list shapes, then the
 * device, then text. (The editor's layers PANEL is the reverse — top first — and so is the
 * `layersJSON` the editor persists alongside a full `canvasJSON`; that pairing restores z-order from
 * `canvasJSON`, never from this array.)
 */
export interface LayerJSON {
	id: string;
	name: string;
	type: LayerType;
	visible: boolean;
	locked: boolean;
	/** Template-related metadata (optional). */
	templateRole?: TemplateRole;
	templateKey?: string;
	/** Serialized Fabric.js object data (null for the background layer). */
	fabricData: object | null;
}

export interface ColorStop {
	offset: number;
	color: string;
}

/** Background is stored separately from layers (it isn't a Fabric object). */
export interface BackgroundJSON {
	type: 'solid' | 'gradient';
	color?: string;
	gradient?: {
		type: 'linear' | 'radial';
		colorStops: ColorStop[];
		/** @deprecated v1 only — use colorStops. Kept for backward compatibility. */
		colors?: string[];
		angle?: number;
		coords?: { x1: number; y1: number; x2: number; y2: number };
	};
}

/**
 * Device GROUP a screen belongs to (multi-device). Mirrors the app's `db.ts` union so a composed
 * template can tag each screen and the editor buckets it into the right sidebar group on import.
 */
export type DeviceClass =
	| 'iphone_6_9'
	| 'iphone_duo_inner'
	| 'iphone_duo_outer'
	| 'ipad_13'
	| 'android_phone'
	| 'macbook';

/** One screen (canvas) of a design. */
export interface ScreenLayersJSON {
	schemaVersion: number;
	canvasWidth?: number;
	canvasHeight?: number;
	/** Device group (multi-device); optional/additive — absent ⇒ the editor infers it. */
	deviceClass?: DeviceClass;
	/** BOTTOM → TOP (index 0 is painted first). See `LayerJSON`. */
	layers: LayerJSON[];
	background?: BackgroundJSON;
}

/** A reusable, multi-screen design — the unit the skill produces + hands off. */
export interface Template {
	id: string;
	name: string;
	description?: string;
	thumbnail: string;
	tags: string[];
	version: string;
	screens: ScreenLayersJSON[];
	createdAt?: string;
	author?: string;
}
