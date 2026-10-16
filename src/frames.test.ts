import { describe, it, expect } from 'vitest';
import { makeDeviceFrameLayer, calculateDeviceScale, computeScreenshotPlacement } from './frames';
import { getDeviceFrame } from './device-frames';

const fabric = (d: object | null) => d as Record<string, unknown>;

describe('makeDeviceFrameLayer', () => {
	it('produces ONE device layer carrying its screenshot as a property', () => {
		const frame = makeDeviceFrameLayer({
			deviceId: 'iphone_16_pro',
			screenshotUrl: '/api/screenshots/abc/raw',
			screenshotWidth: 1179,
			screenshotHeight: 2556
		});

		expect(frame.type).toBe('device');
		const fd = fabric(frame.fabricData);
		expect(fd.layerRole).toBe('frame');
		expect(fd.layerType).toBe('deviceFrame');
		expect(fd.deviceScale).toBeCloseTo(0.15);
		expect(fd.src).toBe('/devices/iphone-16-pro.webp');
		expect(fd.deviceFrameId).toBe(frame.id);

		// Screenshot is data on the frame — no geometry, no clip path.
		expect(fd.screenshot).toEqual({ src: '/api/screenshots/abc/raw', width: 1179, height: 2556 });
		expect(fd.clipPath).toBeUndefined();
	});

	it('records a non-zero rotation and omits the screenshot for an empty frame', () => {
		const rotated = makeDeviceFrameLayer({
			deviceId: 'iphone_16_pro',
			screenshotUrl: '/api/screenshots/abc/raw',
			screenshotWidth: 2556,
			screenshotHeight: 1179,
			screenshotRotation: 90
		});
		expect(fabric(rotated.fabricData).screenshot).toMatchObject({ rotation: 90 });

		const empty = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		expect(fabric(empty.fabricData).screenshot).toBeUndefined();
	});

	it('caps phone scale at 0.15 and centers the frame on a 280x600 canvas', () => {
		const device = getDeviceFrame('iphone_16_pro')!;
		expect(calculateDeviceScale(device, 280, 600)).toBeCloseTo(0.15);

		const frame = makeDeviceFrameLayer({
			deviceId: 'iphone_16_pro',
			screenshotUrl: 'x',
			screenshotWidth: 100,
			screenshotHeight: 200
		});
		expect(fabric(frame.fabricData).left).toBeCloseTo(140); // canvasWidth/2
		expect(fabric(frame.fabricData).top).toBeCloseTo(300); // canvasHeight/2
	});

	it('throws on an unknown device id', () => {
		expect(() => makeDeviceFrameLayer({ deviceId: 'nope' })).toThrow();
	});

	it('requires positive screenshot dims with a screenshotUrl (never emits an invalid 0×0)', () => {
		expect(() => makeDeviceFrameLayer({ deviceId: 'iphone_16_pro', screenshotUrl: '/api/screenshots/a/raw' })).toThrow(
			/screenshotWidth/
		);
		expect(() =>
			makeDeviceFrameLayer({
				deviceId: 'iphone_16_pro',
				screenshotUrl: '/api/screenshots/a/raw',
				screenshotWidth: 0,
				screenshotHeight: 10
			})
		).toThrow();
	});
});

describe('computeScreenshotPlacement', () => {
	const device = getDeviceFrame('iphone_16_pro')!;
	const scale = 0.15;
	const screenW = device.screenBounds.width * scale;
	const screenH = device.screenBounds.height * scale;

	it('fills the screen bounds, centred on the screen area, with a rounded clip', () => {
		const p = computeScreenshotPlacement(
			device,
			{ left: 140, top: 300, scaleX: scale, scaleY: scale, angle: 0, deviceScale: scale },
			{ width: 1179, height: 2556 }
		);
		expect(1179 * p.scaleX).toBeCloseTo(screenW);
		expect(2556 * p.scaleY).toBeCloseTo(screenH);
		// Phone screens are ~centred in the frame PNG.
		const offsetY =
			-(device.imageDimensions.height * scale) / 2 + device.screenBounds.y * scale + screenH / 2;
		expect(p.left).toBeCloseTo(140);
		expect(p.top).toBeCloseTo(300 + offsetY);
		expect(p.angle).toBe(0);
		expect(p.clip).toMatchObject({ width: 1179, height: 2556 });
		// Rendered corner radius == device.cornerRadius at the frame's scale.
		expect(p.clip.rx * p.scaleX).toBeCloseTo(device.cornerRadius * scale);
		expect(p.clip.ry * p.scaleY).toBeCloseTo(device.cornerRadius * scale);
	});

	// Independent geometry: the screen-bounds centre of the frame PNG, mapped to canvas coords by
	// hand from device-frames data (frame is centre-origin, rendered at scaleX/scaleY).
	function screenCentreOnCanvas(
		deviceId: string,
		frame: { left: number; top: number; scaleX: number; scaleY: number }
	) {
		const d = getDeviceFrame(deviceId)!;
		const frameTopLeftX = frame.left - (d.imageDimensions.width * frame.scaleX) / 2;
		const frameTopLeftY = frame.top - (d.imageDimensions.height * frame.scaleY) / 2;
		return {
			x: frameTopLeftX + (d.screenBounds.x + d.screenBounds.width / 2) * frame.scaleX,
			y: frameTopLeftY + (d.screenBounds.y + d.screenBounds.height / 2) * frame.scaleY,
			w: d.screenBounds.width * frame.scaleX,
			h: d.screenBounds.height * frame.scaleY
		};
	}

	for (const deviceId of ['macbook_pro_14', 'macbook_air_13_menu_bar', 'studio_display']) {
		it(`centres the screenshot on the screen bounds of an off-centre frame (${deviceId})`, () => {
			const d = getDeviceFrame(deviceId)!;
			const base = 0.1;
			// base scale, and a frame the user enlarged ×1.7 after creation
			for (const frameScale of [base, base * 1.7]) {
				const frame = { left: 304, top: 190, scaleX: frameScale, scaleY: frameScale };
				const p = computeScreenshotPlacement(d, { ...frame, angle: 0, deviceScale: base }, { width: 3024, height: 1964 });
				const want = screenCentreOnCanvas(deviceId, frame);
				expect(p.left, `${deviceId} x @${frameScale}`).toBeCloseTo(want.x, 6);
				expect(p.top, `${deviceId} y @${frameScale}`).toBeCloseTo(want.y, 6);
				expect(3024 * p.scaleX).toBeCloseTo(want.w, 6);
				expect(1964 * p.scaleY).toBeCloseTo(want.h, 6);
			}
			// The screen really is off-centre for this device (otherwise the test proves nothing).
			const offCentre = d.screenBounds.y + d.screenBounds.height / 2 - d.imageDimensions.height / 2;
			expect(Math.abs(offCentre)).toBeGreaterThan(20);
		});
	}

	it('swaps effective dims at 90° and follows a user-scaled / rotated frame', () => {
		const p = computeScreenshotPlacement(
			device,
			{ left: 0, top: 0, scaleX: scale * 2, scaleY: scale * 2, angle: 90, deviceScale: scale },
			{ width: 2556, height: 1179 },
			90
		);
		// 90° → the 2556-wide image spans the screen HEIGHT; frame scaled ×2 doubles it.
		expect(2556 * p.scaleY).toBeCloseTo(screenH * 2);
		expect(p.angle).toBe(180); // frame angle + own rotation
	});

	// Tilt (shot-dsl 0.4.0 composes frames with an `angle`): the screenshot must sit exactly on the
	// ROTATED screen bounds on attach AND after the user moves / scales / rotates the frame (the
	// editor's syncDeviceFrameLayers uses this same function). Corners compared against geometry
	// derived by hand from device-frames data.
	describe('tilted frames', () => {
		const d = getDeviceFrame('iphone_17_pro_max')!;
		const base = 0.16;
		const natural = { width: 1320, height: 2868 };
		/** Canvas corners (tl, tr, br, bl) of a centre-origin w×h box at (cx, cy), scaled + rotated. */
		const corners = (cx: number, cy: number, w: number, h: number, sx: number, sy: number, angle: number) => {
			const r = (angle * Math.PI) / 180;
			return [
				[-w / 2, -h / 2],
				[w / 2, -h / 2],
				[w / 2, h / 2],
				[-w / 2, h / 2]
			].map(([x, y]) => ({
				x: cx + x * sx * Math.cos(r) - y * sy * Math.sin(r),
				y: cy + x * sx * Math.sin(r) + y * sy * Math.cos(r)
			}));
		};
		/** The frame's screen-bounds corners, by hand: frame-local (unscaled) → canvas. */
		const screenCorners = (frame: { left: number; top: number; scale: number; angle: number }) => {
			const r = (frame.angle * Math.PI) / 180;
			const b = d.screenBounds;
			return [
				[b.x, b.y],
				[b.x + b.width, b.y],
				[b.x + b.width, b.y + b.height],
				[b.x, b.y + b.height]
			].map(([px, py]) => {
				const lx = (px - d.imageDimensions.width / 2) * frame.scale;
				const ly = (py - d.imageDimensions.height / 2) * frame.scale;
				return { x: frame.left + lx * Math.cos(r) - ly * Math.sin(r), y: frame.top + lx * Math.sin(r) + ly * Math.cos(r) };
			});
		};

		for (const angle of [-12, -4, 0, 8, 12, 33]) {
			for (const userScale of [1, 1.3]) {
				it(`screenshot corners == rotated screen bounds (angle ${angle}°, user scale ×${userScale}, moved)`, () => {
					const frame = { left: 173.2, top: 391.7, scale: base * userScale, angle };
					const p = computeScreenshotPlacement(
						d,
						{ left: frame.left, top: frame.top, scaleX: frame.scale, scaleY: frame.scale, angle, deviceScale: base },
						natural
					);
					expect(p.angle).toBe(angle);
					const got = corners(p.left, p.top, natural.width, natural.height, p.scaleX, p.scaleY, p.angle);
					const want = screenCorners(frame);
					got.forEach((c, i) => {
						expect(c.x, `corner ${i} x`).toBeCloseTo(want[i].x, 6);
						expect(c.y, `corner ${i} y`).toBeCloseTo(want[i].y, 6);
					});
				});
			}
		}

		it('a 90°-rotated screenshot in a tilted frame still fills the rotated screen bounds', () => {
			const angle = 10;
			const frame = { left: 140, top: 300, scale: base, angle };
			const p = computeScreenshotPlacement(
				d,
				{ left: frame.left, top: frame.top, scaleX: base, scaleY: base, angle, deviceScale: base },
				// aspect == the screen bounds', so the fit is exact (see the report note on 90° fits)
				{ width: 2870, height: 1320 },
				90
			);
			expect(p.angle).toBe(100);
			const got = corners(p.left, p.top, 2870, 1320, p.scaleX, p.scaleY, p.angle);
			const want = screenCorners(frame);
			// image tl lands on the screen's tr (rotated a quarter turn clockwise)
			[1, 2, 3, 0].forEach((wi, gi) => {
				expect(got[gi].x).toBeCloseTo(want[wi].x, 6);
				expect(got[gi].y).toBeCloseTo(want[wi].y, 6);
			});
		});
	});
});
