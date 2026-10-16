import { getDeviceFrame, type DeviceFrame } from './device-frames';
import type { DeviceScreenshotJSON, LayerJSON } from './types';
import { generateLayerId } from './validate';

const DEFAULT_CANVAS_WIDTH = 280;
const DEFAULT_CANVAS_HEIGHT = 600;

/**
 * Mirror of FabricCanvas.calculateDeviceScale(): fit the device PNG within 85% of
 * the canvas, capped at 0.15. Kept identical so composed frames size like the editor's.
 */
export function calculateDeviceScale(
	device: DeviceFrame,
	canvasWidth = DEFAULT_CANVAS_WIDTH,
	canvasHeight = DEFAULT_CANVAS_HEIGHT
): number {
	const maxWidth = canvasWidth * 0.85;
	const maxHeight = canvasHeight * 0.85;
	return Math.min(
		maxWidth / device.imageDimensions.width,
		maxHeight / device.imageDimensions.height,
		0.15
	);
}

/**
 * Build a device-mockup layer — a Fabric-free reproduction of the frame half of
 * FabricCanvas.addDeviceFrame(). The screenshot rides on the frame as
 * `fabricData.screenshot` (see `DeviceScreenshotJSON`); the editor places + clips it
 * under the frame on import (same path as dropping a screenshot onto a frame), so no
 * screenshot geometry or clip path is emitted here.
 *
 * `screenshotWidth`/`screenshotHeight` are the screenshot's natural pixel size
 * (the composer supplies them from the uploaded asset's stored dimensions) and are
 * required with `screenshotUrl` (throws otherwise). Omit `screenshotUrl` for an empty frame.
 */
export function makeDeviceFrameLayer(opts: {
	deviceId: string;
	screenshotUrl?: string;
	screenshotWidth?: number;
	screenshotHeight?: number;
	canvasWidth?: number;
	canvasHeight?: number;
	centerX?: number;
	centerY?: number;
	scale?: number;
	screenshotRotation?: number;
	/** Clockwise tilt of the whole mockup in degrees (the editor rotates the screenshot with it). */
	angle?: number;
	name?: string;
}): LayerJSON {
	const device = getDeviceFrame(opts.deviceId);
	if (!device) throw new Error(`Unknown device: ${opts.deviceId}`);

	const canvasWidth = opts.canvasWidth ?? DEFAULT_CANVAS_WIDTH;
	const canvasHeight = opts.canvasHeight ?? DEFAULT_CANVAS_HEIGHT;
	const scale = opts.scale ?? calculateDeviceScale(device, canvasWidth, canvasHeight);

	const frameId = `device-frame-${generateLayerId()}`;

	const fabricData: Record<string, unknown> = {
		type: 'image',
		src: device.frameAsset,
		crossOrigin: 'anonymous',
		left: opts.centerX ?? canvasWidth / 2,
		top: opts.centerY ?? canvasHeight / 2,
		width: device.imageDimensions.width,
		height: device.imageDimensions.height,
		scaleX: scale,
		scaleY: scale,
		originX: 'center',
		originY: 'center',
		layerId: frameId,
		layerType: 'deviceFrame',
		deviceFrameId: frameId,
		layerRole: 'frame',
		deviceId: opts.deviceId,
		deviceScale: scale
	};
	if (opts.angle) fabricData.angle = opts.angle;

	if (opts.screenshotUrl) {
		const { screenshotWidth: width, screenshotHeight: height } = opts;
		if (!(typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0)) {
			throw new Error('makeDeviceFrameLayer: screenshotWidth/screenshotHeight (> 0) are required with screenshotUrl');
		}
		const screenshot: DeviceScreenshotJSON = { src: opts.screenshotUrl, width, height };
		if (opts.screenshotRotation) screenshot.rotation = opts.screenshotRotation;
		fabricData.screenshot = screenshot;
	}

	return {
		id: frameId,
		name: opts.name ?? device.name,
		type: 'device',
		visible: true,
		locked: false,
		fabricData
	};
}

/** Where a frame currently sits on the canvas (a Fabric object's relevant props). */
export interface DeviceFramePose {
	left?: number;
	top?: number;
	scaleX?: number;
	scaleY?: number;
	angle?: number;
	/** The frame's base scale when it was created (`fabricData.deviceScale`). */
	deviceScale?: number;
}

/** Fabric props for a screenshot placed inside a frame; `clip` is a centered Rect in the image's local space. */
export interface ScreenshotPlacement {
	left: number;
	top: number;
	scaleX: number;
	scaleY: number;
	angle: number;
	clip: { width: number; height: number; rx: number; ry: number };
}

/**
 * THE screenshot-in-frame geometry: fit a screenshot of natural size `natural` to the
 * device's screen bounds for a frame at `frame`, optionally rotated by `rotation`
 * (0/90/180/270 — 90/270 swap the effective dimensions), with a rounded clip matching
 * `device.cornerRadius`. Used by the editor (FabricCanvas.updateDeviceFrameScreenshot)
 * and the offscreen thumbnail/export renderers so all three place screenshots identically.
 */
export function computeScreenshotPlacement(
	device: DeviceFrame,
	frame: DeviceFramePose,
	natural: { width: number; height: number },
	rotation = 0
): ScreenshotPlacement {
	const scale = frame.deviceScale || 0.15;
	const scaledImageWidth = device.imageDimensions.width * scale;
	const scaledImageHeight = device.imageDimensions.height * scale;
	const screenWidth = device.screenBounds.width * scale;
	const screenHeight = device.screenBounds.height * scale;
	const screenOffsetX = device.screenBounds.x * scale;
	const screenOffsetY = device.screenBounds.y * scale;
	const cornerRadius = device.cornerRadius * scale;

	const naturalWidth = natural.width || 1;
	const naturalHeight = natural.height || 1;

	// When rotated 90 or 270, the effective dimensions are swapped.
	const isRotated90or270 = rotation === 90 || rotation === 270;
	const effectiveWidth = isRotated90or270 ? naturalHeight : naturalWidth;
	const effectiveHeight = isRotated90or270 ? naturalWidth : naturalHeight;

	// Scale to fit the screen bounds using the effective dimensions.
	const imgScaleX = screenWidth / effectiveWidth;
	const imgScaleY = screenHeight / effectiveHeight;

	const frameLeft = frame.left || 0;
	const frameTop = frame.top || 0;
	const frameScaleX = frame.scaleX || 1;
	const frameScaleY = frame.scaleY || 1;
	const frameAngle = frame.angle || 0;

	// Screen center offset from the frame center (at the frame's base scale), rotated with the frame.
	const offsetX = -(scaledImageWidth / 2) + screenOffsetX + screenWidth / 2;
	const offsetY = -(scaledImageHeight / 2) + screenOffsetY + screenHeight / 2;
	const angleRad = (frameAngle * Math.PI) / 180;
	const rotatedOffsetX = offsetX * Math.cos(angleRad) - offsetY * Math.sin(angleRad);
	const rotatedOffsetY = offsetX * Math.sin(angleRad) + offsetY * Math.cos(angleRad);

	// The frame's current scale relative to its base deviceScale (1 unless the user resized it).
	const frameScaleRatioX = frameScaleX / scale;
	const frameScaleRatioY = frameScaleY / scale;

	return {
		// The offset is already in base-scale canvas units, so it scales by the RATIO, not the
		// absolute frame scale (≤0.2 editors multiplied by frameScale, shrinking off-centre screen
		// offsets ~7× — visible on MacBooks, whose screen sits above the frame centre).
		left: frameLeft + rotatedOffsetX * frameScaleRatioX,
		top: frameTop + rotatedOffsetY * frameScaleRatioY,
		scaleX: imgScaleX * frameScaleRatioX,
		scaleY: imgScaleY * frameScaleRatioY,
		// The screenshot's visual angle combines the frame rotation and its own rotation.
		angle: frameAngle + rotation,
		// The clipPath lives in the image's local (unscaled) coordinate space.
		clip: {
			width: naturalWidth,
			height: naturalHeight,
			rx: cornerRadius / imgScaleX,
			ry: cornerRadius / imgScaleY
		}
	};
}
