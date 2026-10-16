import type { BackgroundJSON, ColorStop, DeviceClass, LayerJSON, ScreenLayersJSON, Template, TemplateRole } from './types';
import { CURRENT_SCHEMA_VERSION } from './types';
import { generateLayerId } from './validate';

/** Common per-layer metadata accepted by every builder. */
interface LayerMeta {
	id?: string;
	name?: string;
	visible?: boolean;
	locked?: boolean;
	templateRole?: TemplateRole;
	templateKey?: string;
}

const DEFAULT_CANVAS_WIDTH = 280;
const DEFAULT_CANVAS_HEIGHT = 600;

// ---- Backgrounds ----

export function makeSolidBackground(color: string): BackgroundJSON {
	return { type: 'solid', color };
}

export function makeGradientBackground(opts: {
	colorStops: ColorStop[];
	type?: 'linear' | 'radial';
	coords?: { x1: number; y1: number; x2: number; y2: number };
}): BackgroundJSON {
	return {
		type: 'gradient',
		gradient: { type: opts.type ?? 'linear', colorStops: opts.colorStops, coords: opts.coords }
	};
}

// ---- Layers ----

export function makeTextLayer(
	opts: {
		text: string;
		left: number;
		top: number;
		width: number;
		fontSize?: number;
		fontFamily?: string;
		fontWeight?: string;
		fill?: string;
		textAlign?: 'left' | 'center' | 'right';
		lineHeight?: number;
		originX?: 'left' | 'center' | 'right';
		originY?: 'top' | 'center' | 'bottom';
	} & LayerMeta
): LayerJSON {
	const id = opts.id ?? generateLayerId();
	return {
		id,
		name: opts.name ?? 'Text',
		type: 'text',
		visible: opts.visible ?? true,
		locked: opts.locked ?? false,
		templateRole: opts.templateRole,
		templateKey: opts.templateKey,
		fabricData: {
			type: 'Textbox',
			left: opts.left,
			top: opts.top,
			width: opts.width,
			text: opts.text,
			fill: opts.fill ?? '#ffffff',
			fontSize: opts.fontSize ?? 28,
			fontFamily: opts.fontFamily ?? 'Inter',
			fontWeight: opts.fontWeight ?? '700',
			textAlign: opts.textAlign ?? 'center',
			lineHeight: opts.lineHeight ?? 1.1,
			// Match the editor convention (addText, makeImageLayer, makeShapeLayer all
			// use center origin) so `left`/`top` are the box center, not its corner.
			originX: opts.originX ?? 'center',
			originY: opts.originY ?? 'center',
			layerId: id,
			layerType: 'text'
		}
	};
}

export function makeImageLayer(
	opts: {
		src: string;
		left: number;
		top: number;
		width: number;
		height: number;
		scaleX?: number;
		scaleY?: number;
		originX?: 'left' | 'center' | 'right';
		originY?: 'top' | 'center' | 'bottom';
		imageCornerRadius?: number;
	} & LayerMeta
): LayerJSON {
	const id = opts.id ?? generateLayerId();
	return {
		id,
		name: opts.name ?? 'Image',
		type: 'image',
		visible: opts.visible ?? true,
		locked: opts.locked ?? false,
		templateRole: opts.templateRole,
		templateKey: opts.templateKey,
		fabricData: {
			type: 'image',
			left: opts.left,
			top: opts.top,
			width: opts.width,
			height: opts.height,
			scaleX: opts.scaleX ?? 1,
			scaleY: opts.scaleY ?? 1,
			src: opts.src,
			originX: opts.originX ?? 'center',
			originY: opts.originY ?? 'center',
			...(opts.imageCornerRadius ? { imageCornerRadius: opts.imageCornerRadius } : {}),
			layerId: id,
			layerType: 'image'
		}
	};
}

export function makeShapeLayer(
	opts: {
		shape: 'rectangle' | 'circle';
		left: number;
		top: number;
		width?: number;
		height?: number;
		radius?: number;
		fill?: string;
		rx?: number;
		ry?: number;
	} & LayerMeta
): LayerJSON {
	const id = opts.id ?? generateLayerId();
	const common = {
		left: opts.left,
		top: opts.top,
		fill: opts.fill ?? '#0ea5e9',
		originX: 'center',
		originY: 'center',
		layerId: id,
		layerType: 'shape'
	};
	const fabricData =
		opts.shape === 'circle'
			? { type: 'circle', radius: opts.radius ?? 50, ...common, shapeType: 'circle' }
			: {
					type: 'Rect',
					width: opts.width ?? 100,
					height: opts.height ?? 100,
					rx: opts.rx ?? 0,
					ry: opts.ry ?? 0,
					...common,
					shapeType: 'rectangle'
				};
	return {
		id,
		name: opts.name ?? 'Shape',
		type: 'shape',
		visible: opts.visible ?? true,
		locked: opts.locked ?? false,
		templateRole: opts.templateRole,
		templateKey: opts.templateKey,
		fabricData
	};
}

// ---- Assembly ----

export function makeScreen(opts: {
	layers: LayerJSON[];
	background?: BackgroundJSON;
	canvasWidth?: number;
	canvasHeight?: number;
	deviceClass?: DeviceClass;
}): ScreenLayersJSON {
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		canvasWidth: opts.canvasWidth ?? DEFAULT_CANVAS_WIDTH,
		canvasHeight: opts.canvasHeight ?? DEFAULT_CANVAS_HEIGHT,
		deviceClass: opts.deviceClass,
		layers: opts.layers,
		background: opts.background
	};
}

export function makeTemplate(opts: {
	id?: string;
	name: string;
	screens: ScreenLayersJSON[];
	description?: string;
	thumbnail?: string;
	tags?: string[];
	version?: string;
	author?: string;
}): Template {
	return {
		id: opts.id ?? generateLayerId(),
		name: opts.name,
		description: opts.description,
		thumbnail: opts.thumbnail ?? '',
		tags: opts.tags ?? [],
		version: opts.version ?? '1.0.0',
		screens: opts.screens,
		createdAt: new Date().toISOString(),
		author: opts.author
	};
}
