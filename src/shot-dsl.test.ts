import { describe, it, expect } from 'vitest';
import {
	makeSolidBackground,
	makeTextLayer,
	makeImageLayer,
	makeShapeLayer,
	makeScreen,
	makeTemplate
} from './builders';
import {
	validateTemplate,
	isValidTemplate,
	isValidScreenLayersJSON,
	isUploadedScreenshotSrc,
	EDITOR_INTERNAL_PROPS
} from './validate';
import { makeDeviceFrameLayer } from './frames';
import { CURRENT_SCHEMA_VERSION } from './types';

const fabric = (data: object | null) => data as Record<string, unknown>;

describe('shot-dsl builders', () => {
	it('makeTextLayer produces a valid text layer with Textbox fabricData', () => {
		const layer = makeTextLayer({ text: 'Hello', left: 20, top: 40, width: 240 });
		expect(layer.type).toBe('text');
		expect(layer.fabricData).toMatchObject({ type: 'Textbox', text: 'Hello', layerType: 'text' });
		expect(fabric(layer.fabricData).layerId).toBe(layer.id);
	});

	it('makeImageLayer + makeShapeLayer tag the fabric type and layerType', () => {
		const img = makeImageLayer({ src: 'data:x', left: 0, top: 0, width: 10, height: 10 });
		expect(img.type).toBe('image');
		expect(fabric(img.fabricData).type).toBe('image');
		expect(fabric(img.fabricData).layerType).toBe('image');

		expect(fabric(makeShapeLayer({ shape: 'rectangle', left: 0, top: 0 }).fabricData).type).toBe('Rect');
		expect(fabric(makeShapeLayer({ shape: 'circle', left: 0, top: 0, radius: 30 }).fabricData).type).toBe(
			'circle'
		);
	});

	it('every builder assigns a unique id', () => {
		const a = makeTextLayer({ text: 'a', left: 0, top: 0, width: 10 });
		const b = makeTextLayer({ text: 'b', left: 0, top: 0, width: 10 });
		expect(a.id).not.toBe(b.id);
	});
});

describe('shot-dsl assembly + validation', () => {
	it('a built template is valid', () => {
		const screen = makeScreen({
			background: makeSolidBackground('#0f172a'),
			layers: [
				makeTextLayer({ text: 'Title', left: 20, top: 40, width: 240 }),
				makeImageLayer({ src: '/api/screenshots/a/raw', left: 140, top: 300, width: 100, height: 200 })
			]
		});
		const tpl = makeTemplate({ name: 'Test', screens: [screen] });

		expect(screen.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(isValidScreenLayersJSON(screen)).toBe(true);
		expect(isValidTemplate(tpl)).toBe(true);

		const result = validateTemplate(tpl);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('validateTemplate reports errors for bad input', () => {
		expect(validateTemplate(null).valid).toBe(false);
		expect(validateTemplate({ id: 'x', name: 'x', screens: [] }).valid).toBe(false);

		const r = validateTemplate({ id: '', name: '', screens: 'nope' });
		expect(r.valid).toBe(false);
		expect(r.errors.length).toBeGreaterThan(0);
	});
});

describe('device-layer screenshot validation', () => {
	const screenWith = (layers: unknown[]) =>
		makeTemplate({ name: 'T', screens: [makeScreen({ background: makeSolidBackground('#000'), layers: layers as never })] });
	const deviceLayer = (screenshot: unknown, extra: Record<string, unknown> = {}) => {
		const frame = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		(frame.fabricData as Record<string, unknown>).screenshot = screenshot;
		Object.assign(frame.fabricData as Record<string, unknown>, extra);
		return frame;
	};
	const good = { src: '/api/screenshots/734fcbe3-42c3-4880-b99f-9fb948d398bd/raw', width: 1320, height: 2868 };

	it('accepts the 0.3.0 shape (screenshot as a device-layer property)', () => {
		expect(validateTemplate(screenWith([deviceLayer(good)]))).toEqual({ valid: true, errors: [] });
		expect(validateTemplate(screenWith([deviceLayer({ ...good, rotation: 270 })])).valid).toBe(true);
		expect(isUploadedScreenshotSrc(good.src)).toBe(true);
	});

	it('still accepts the legacy ≤0.2.0 shape (separate layerRole:screenshot image layer)', () => {
		const frame = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		const frameId = (frame.fabricData as Record<string, unknown>).deviceFrameId;
		const legacyShot = makeImageLayer({ src: '/api/screenshots/a/raw', left: 140, top: 300, width: 1179, height: 2556 });
		Object.assign(legacyShot.fabricData as Record<string, unknown>, {
			layerRole: 'screenshot',
			deviceFrameId: frameId,
			clipPath: { type: 'Rect', width: 1179, height: 2556, rx: 140, ry: 140 }
		});
		expect(validateTemplate(screenWith([legacyShot, frame]))).toEqual({ valid: true, errors: [] });
	});

	it('rejects screenshot srcs that are not the uploaded-asset form', () => {
		for (const src of [
			'https://evil.example/x.png',
			'//evil.example/api/screenshots/a/raw',
			'data:image/png;base64,AAAA',
			'javascript:alert(1)',
			'/api/screenshots/../../admin/raw',
			'/api/screenshots/a/raw?x=1',
			'/devices/iphone-16-pro.webp',
			'',
			42
		]) {
			const r = validateTemplate(screenWith([deviceLayer({ ...good, src })]));
			expect(r.valid, String(src)).toBe(false);
			expect(r.errors.join(' ')).toMatch(/src must be an uploaded screenshot URL/);
		}
	});

	it('rejects bad dims, rotation, unknown keys, non-objects, misplacement and a missing deviceId', () => {
		const errs = (layers: unknown[]) => validateTemplate(screenWith(layers)).errors.join(' | ');
		expect(errs([deviceLayer({ ...good, width: 0 })])).toMatch(/width must be a positive number/);
		expect(errs([deviceLayer({ ...good, height: 'tall' })])).toMatch(/height must be a positive number/);
		expect(errs([deviceLayer({ ...good, rotation: 45 })])).toMatch(/rotation must be one of/);
		expect(errs([deviceLayer({ ...good, onload: 'x' })])).toMatch(/onload is not allowed/);
		expect(errs([deviceLayer('/api/screenshots/a/raw')])).toMatch(/screenshot must be an object/);
		expect(errs([deviceLayer(good, { deviceId: undefined })])).toMatch(/deviceId must be a known device id/);

		const text = makeTextLayer({ text: 'x', left: 0, top: 0, width: 10 });
		(text.fabricData as Record<string, unknown>).screenshot = good;
		expect(errs([text])).toMatch(/only allowed on device layers/);
	});
});

describe('handoff hardening (legacy src, device src/id, duplicates)', () => {
	const tpl = (layers: unknown[]) =>
		makeTemplate({ name: 'T', screens: [makeScreen({ background: makeSolidBackground('#000'), layers: layers as never })] });
	const errs = (layers: unknown[]) => validateTemplate(tpl(layers)).errors.join(' | ');
	const legacyShot = (src: unknown, frameId: unknown) => {
		const l = makeImageLayer({ src: 'x', left: 0, top: 0, width: 10, height: 10 });
		Object.assign(l.fabricData as Record<string, unknown>, { src, layerRole: 'screenshot', deviceFrameId: frameId });
		return l;
	};

	it('holds legacy screenshot layers to the uploaded-asset src rule', () => {
		const frame = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		const fid = (frame.fabricData as Record<string, unknown>).deviceFrameId;
		expect(validateTemplate(tpl([legacyShot('/api/screenshots/a/raw', fid), frame])).valid).toBe(true);
		for (const src of ['https://evil.example/x.png', 'data:image/png;base64,AA', '/api/screenshots/../x/raw', 7]) {
			expect(errs([legacyShot(src, fid), frame]), String(src)).toMatch(/fabricData.src must be an uploaded screenshot URL/);
		}
		// A legacy screenshot role on a non-image layer is rejected.
		const rect = makeShapeLayer({ shape: 'rectangle', left: 0, top: 0 });
		Object.assign(rect.fabricData as Record<string, unknown>, { layerRole: 'screenshot', src: '/api/screenshots/a/raw' });
		expect(errs([rect])).toMatch(/layerRole "screenshot" is only allowed on image layers/);
	});

	it('restricts a device layer to a known deviceId and a /devices/ frame asset', () => {
		const frame = () => makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		const withFd = (extra: Record<string, unknown>) => {
			const f = frame();
			Object.assign(f.fabricData as Record<string, unknown>, extra);
			return f;
		};
		expect(errs([withFd({ deviceId: 'iphone_99' })])).toMatch(/deviceId must be a known device id/);
		for (const src of ['https://evil.example/f.webp', '/devices/../api/x.webp', '/devices/a/b.webp', '/devices/x.svg', 'data:x']) {
			expect(errs([withFd({ src })]), src).toMatch(/must be a device frame asset/);
		}
		expect(validateTemplate(tpl([withFd({ src: '/devices/iphone-16-pro.png' })])).valid).toBe(true);
	});

	it('rejects duplicate layer ids and duplicate deviceFrameIds within a screen', () => {
		const a = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		const b = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		(b.fabricData as Record<string, unknown>).deviceFrameId = (a.fabricData as Record<string, unknown>).deviceFrameId;
		expect(errs([a, b])).toMatch(/deviceFrameId .* is duplicated/);
		const t = makeTextLayer({ text: 'x', left: 0, top: 0, width: 10 });
		expect(errs([t, { ...t }])).toMatch(/id .* is duplicated/);
	});
});

describe('handoff trust boundary (second-pass review N1, L5)', () => {
	const tpl = (layers: unknown[]) =>
		makeTemplate({ name: 'T', screens: [makeScreen({ background: makeSolidBackground('#000'), layers: layers as never })] });
	const errs = (layers: unknown[]) => validateTemplate(tpl(layers)).errors.join(' | ');

	it('N1: rejects the reviewer probe (non-device "frame" layer carrying pendingScreenshot)', () => {
		const probe = {
			id: 'a',
			name: 'x',
			type: 'image',
			visible: true,
			locked: false,
			fabricData: {
				type: 'image',
				src: 'data:image/png;base64,AAAA',
				layerRole: 'frame',
				deviceId: 'iphone_16_pro',
				deviceFrameId: 'f1',
				deviceScale: 0.15,
				pendingScreenshot: { src: 'https://evil.example/x.png', rotation: 0 }
			}
		};
		const r = validateTemplate(tpl([probe]));
		expect(r.valid).toBe(false);
		const joined = r.errors.join(' | ');
		expect(joined).toMatch(/pendingScreenshot is editor-internal/);
		expect(joined).toMatch(/layerRole is only allowed on device/);
		expect(joined).toMatch(/deviceFrameId is only allowed/);
		expect(joined).toMatch(/src must be an uploaded screenshot .* or a device frame asset/);
	});

	it('N1: rejects editor-internal props on any layer, including legit device layers', () => {
		for (const prop of EDITOR_INTERNAL_PROPS) {
			const frame = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
			(frame.fabricData as Record<string, unknown>)[prop] = prop === 'pendingScreenshot' ? { src: '/api/screenshots/a/raw' } : 1;
			expect(errs([frame]), prop).toMatch(new RegExp(`${prop} is editor-internal`));
		}
	});

	it('N1: a device layer may only carry the "frame" role', () => {
		const frame = makeDeviceFrameLayer({ deviceId: 'iphone_16_pro' });
		(frame.fabricData as Record<string, unknown>).layerRole = 'screenshot';
		expect(errs([frame])).toMatch(/layerRole must be "frame" on a device layer/);
	});

	it('L5: image layers, pattern fills and nested objects only reference same-origin uploads / frame assets', () => {
		const img = (src: unknown) => makeImageLayer({ src: src as string, left: 0, top: 0, width: 1, height: 1 });
		expect(validateTemplate(tpl([img('/api/screenshots/abc/raw')])).valid).toBe(true);
		expect(validateTemplate(tpl([img('/devices/iphone-16-pro.webp')])).valid).toBe(true);
		for (const bad of [
			'https://evil.example/x.png',
			'//evil.example/x.png',
			'data:image/png;base64,AA',
			'javascript:alert(1)',
			'/api/screenshots/../../x/raw',
			'/uploads/x.png'
		]) {
			expect(errs([img(bad)]), bad).toMatch(/must be an uploaded screenshot/);
		}

		const shape = makeShapeLayer({ shape: 'rectangle', left: 0, top: 0 });
		(shape.fabricData as Record<string, unknown>).fill = { type: 'pattern', source: 'https://evil.example/p.png' };
		expect(errs([shape])).toMatch(/fill\.source must be an uploaded screenshot/);
		(shape.fabricData as Record<string, unknown>).fill = { type: 'pattern', source: '/api/screenshots/p/raw' };
		expect(validateTemplate(tpl([shape])).valid).toBe(true);

		const group = makeShapeLayer({ shape: 'rectangle', left: 0, top: 0 });
		(group.fabricData as Record<string, unknown>).objects = [{ type: 'image', src: 'data:x' }];
		expect(errs([group])).toMatch(/objects\[0\]\.src must be an uploaded screenshot/);
	});
});

describe('forbidden keys (third-pass T3)', () => {
	const tplFromJSON = (layerJSON: string) =>
		JSON.parse(
			`{"id":"t","name":"T","thumbnail":"","tags":[],"version":"1","screens":[{"schemaVersion":2,"layers":[${layerJSON}]}]}`
		);

	it('rejects __proto__ carrying frame metadata (JSON.parse makes it a real own key)', () => {
		const t = tplFromJSON(
			'{"id":"a","name":"x","type":"shape","visible":true,"locked":false,"fabricData":{"type":"Rect","__proto__":{"layerRole":"frame","deviceFrameId":"f1","deviceId":"iphone_16_pro","pendingScreenshot":{"src":"/api/screenshots/a/raw"}}}}'
		);
		const fd = t.screens[0].layers[0].fabricData;
		expect(Object.keys(fd)).toContain('__proto__'); // the probe really has the key
		expect(fd.layerRole).toBeUndefined(); // …invisible to plain property checks
		const r = validateTemplate(t);
		expect(r.valid).toBe(false);
		expect(r.errors.join(' | ')).toMatch(/fabricData\.__proto__ is not allowed/);
	});

	it('rejects constructor / prototype at any depth, and on the layer itself', () => {
		for (const [json, path] of [
			['{"id":"a","name":"x","type":"shape","visible":true,"locked":false,"fabricData":{"type":"Rect","constructor":{}}}', 'fabricData.constructor'],
			['{"id":"a","name":"x","type":"shape","visible":true,"locked":false,"fabricData":{"type":"Rect","fill":{"prototype":1}}}', 'fabricData.fill.prototype'],
			['{"id":"a","name":"x","type":"shape","visible":true,"locked":false,"fabricData":{"type":"Group","objects":[{"__proto__":{"src":"x"}}]}}', 'fabricData.objects[0].__proto__'],
			['{"id":"a","name":"x","type":"shape","visible":true,"locked":false,"__proto__":{"x":1},"fabricData":null}', 'layers[0].__proto__']
		]) {
			const r = validateTemplate(tplFromJSON(json));
			expect(r.valid, path).toBe(false);
			expect(r.errors.join(' | '), path).toContain(`${path} is not allowed`);
		}
	});
});
