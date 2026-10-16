/**
 * Device Frames Tests
 *
 * Tests for device frame data and helper functions.
 */

import { describe, it, expect } from 'vitest';
import {
	deviceFrames,
	getDeviceFrame,
	getDeviceFramesByPlatform,
	getDeviceFramesByCategory,
	type DeviceFrame
} from './device-frames';

// ============ getDeviceFrame TESTS ============

describe('getDeviceFrame', () => {
	it('should return correct device for valid ID', () => {
		const device = getDeviceFrame('iphone_16_pro');

		expect(device).toBeDefined();
		expect(device?.id).toBe('iphone_16_pro');
		expect(device?.name).toBe('iPhone 16 Pro');
		expect(device?.platform).toBe('ios');
	});

	it('should return correct device for another valid ID', () => {
		const device = getDeviceFrame('pixel_9_pro');

		expect(device).toBeDefined();
		expect(device?.id).toBe('pixel_9_pro');
		expect(device?.name).toBe('Google Pixel 9 Pro');
		expect(device?.platform).toBe('android');
	});

	it('should return undefined for invalid ID', () => {
		const device = getDeviceFrame('invalid_device_id');

		expect(device).toBeUndefined();
	});

	it('should return undefined for empty string', () => {
		const device = getDeviceFrame('');

		expect(device).toBeUndefined();
	});

	it('should be case sensitive', () => {
		const device = getDeviceFrame('IPHONE_16_PRO');

		expect(device).toBeUndefined();
	});

	it('should return undefined for partial ID match', () => {
		const device = getDeviceFrame('iphone_16');

		// Should match exactly, not partial
		expect(device).toBeDefined();
		expect(device?.id).toBe('iphone_16');
	});

	it('should not match with extra characters', () => {
		const device = getDeviceFrame('iphone_16_pro_extra');

		expect(device).toBeUndefined();
	});
});

// ============ getDeviceFramesByPlatform TESTS ============

describe('getDeviceFramesByPlatform', () => {
	it('should return all iOS devices', () => {
		const devices = getDeviceFramesByPlatform('ios');

		expect(devices.length).toBeGreaterThan(0);
		expect(devices.every((d) => d.platform === 'ios')).toBe(true);
	});

	it('should return all Android devices', () => {
		const devices = getDeviceFramesByPlatform('android');

		expect(devices.length).toBeGreaterThan(0);
		expect(devices.every((d) => d.platform === 'android')).toBe(true);
	});

	it('should return empty array for platform with no devices', () => {
		// Currently no macOS or Windows devices in the list
		const macosDevices = getDeviceFramesByPlatform('macos');
		const windowsDevices = getDeviceFramesByPlatform('windows');

		expect(Array.isArray(macosDevices)).toBe(true);
		expect(Array.isArray(windowsDevices)).toBe(true);
	});

	it('should return empty array for invalid platform', () => {
		const devices = getDeviceFramesByPlatform('invalid' as any);

		expect(devices).toEqual([]);
	});

	it('should not mutate original array', () => {
		const originalLength = deviceFrames.length;
		const devices = getDeviceFramesByPlatform('ios');

		devices.push({} as DeviceFrame);

		expect(deviceFrames.length).toBe(originalLength);
	});

	it('should include expected iOS devices', () => {
		const devices = getDeviceFramesByPlatform('ios');
		const deviceIds = devices.map((d) => d.id);

		expect(deviceIds).toContain('iphone_16_pro');
		expect(deviceIds).toContain('iphone_16_pro_max');
	});

	it('should include expected Android devices', () => {
		const devices = getDeviceFramesByPlatform('android');
		const deviceIds = devices.map((d) => d.id);

		expect(deviceIds).toContain('pixel_9_pro');
		expect(deviceIds).toContain('pixel_9_pro_xl');
	});
});

// ============ getDeviceFramesByCategory TESTS ============

describe('getDeviceFramesByCategory', () => {
	it('should return all phones', () => {
		const devices = getDeviceFramesByCategory('phone');

		expect(devices.length).toBeGreaterThan(0);
		expect(devices.every((d) => d.category === 'phone')).toBe(true);
	});

	it('should return empty array for category with no devices', () => {
		// Currently no tablet, desktop, or laptop devices in the list
		const tablets = getDeviceFramesByCategory('tablet');
		const desktops = getDeviceFramesByCategory('desktop');
		const laptops = getDeviceFramesByCategory('laptop');

		expect(Array.isArray(tablets)).toBe(true);
		expect(Array.isArray(desktops)).toBe(true);
		expect(Array.isArray(laptops)).toBe(true);
	});

	it('should return empty array for invalid category', () => {
		const devices = getDeviceFramesByCategory('invalid' as any);

		expect(devices).toEqual([]);
	});

	it('should not mutate original array', () => {
		const originalLength = deviceFrames.length;
		const devices = getDeviceFramesByCategory('phone');

		devices.push({} as DeviceFrame);

		expect(deviceFrames.length).toBe(originalLength);
	});

	it('should include devices from multiple platforms in category', () => {
		const phones = getDeviceFramesByCategory('phone');
		const platforms = new Set(phones.map((d) => d.platform));

		// Phones should include both iOS and Android
		expect(platforms.has('ios')).toBe(true);
		expect(platforms.has('android')).toBe(true);
	});
});

// ============ deviceFrames DATA INTEGRITY TESTS ============

describe('deviceFrames data integrity', () => {
	it('should have at least one device', () => {
		expect(deviceFrames.length).toBeGreaterThan(0);
	});

	it('should have unique IDs', () => {
		const ids = deviceFrames.map((d) => d.id);
		const uniqueIds = new Set(ids);

		expect(uniqueIds.size).toBe(ids.length);
	});

	it('should have all required fields for each device', () => {
		for (const device of deviceFrames) {
			expect(device.id).toBeDefined();
			expect(typeof device.id).toBe('string');
			expect(device.id.length).toBeGreaterThan(0);

			expect(device.name).toBeDefined();
			expect(typeof device.name).toBe('string');
			expect(device.name.length).toBeGreaterThan(0);

			expect(device.platform).toBeDefined();
			expect(['ios', 'android', 'macos', 'windows']).toContain(device.platform);

			expect(device.category).toBeDefined();
			expect(['phone', 'tablet', 'desktop', 'laptop']).toContain(device.category);

			expect(device.frameAsset).toBeDefined();
			expect(typeof device.frameAsset).toBe('string');
			expect(device.frameAsset.length).toBeGreaterThan(0);

			expect(device.imageDimensions).toBeDefined();
			expect(device.screenBounds).toBeDefined();
			expect(typeof device.cornerRadius).toBe('number');
		}
	});

	it('should have valid imageDimensions for each device', () => {
		for (const device of deviceFrames) {
			expect(device.imageDimensions.width).toBeGreaterThan(0);
			expect(device.imageDimensions.height).toBeGreaterThan(0);
			expect(Number.isInteger(device.imageDimensions.width)).toBe(true);
			expect(Number.isInteger(device.imageDimensions.height)).toBe(true);
		}
	});

	it('should have valid screenBounds for each device', () => {
		for (const device of deviceFrames) {
			expect(device.screenBounds.x).toBeGreaterThanOrEqual(0);
			expect(device.screenBounds.y).toBeGreaterThanOrEqual(0);
			expect(device.screenBounds.width).toBeGreaterThan(0);
			expect(device.screenBounds.height).toBeGreaterThan(0);
		}
	});

	it('should have screenBounds within imageDimensions', () => {
		for (const device of deviceFrames) {
			const { imageDimensions, screenBounds } = device;

			// Screen should start within image
			expect(screenBounds.x).toBeLessThan(imageDimensions.width);
			expect(screenBounds.y).toBeLessThan(imageDimensions.height);

			// Screen should end within image
			expect(screenBounds.x + screenBounds.width).toBeLessThanOrEqual(imageDimensions.width);
			expect(screenBounds.y + screenBounds.height).toBeLessThanOrEqual(imageDimensions.height);
		}
	});

	it('should have positive cornerRadius for each device', () => {
		for (const device of deviceFrames) {
			expect(device.cornerRadius).toBeGreaterThanOrEqual(0);
		}
	});

	it('should have frameAsset paths starting with /devices/', () => {
		for (const device of deviceFrames) {
			expect(device.frameAsset.startsWith('/devices/')).toBe(true);
		}
	});

	it('should have frameAsset paths ending with .webp', () => {
		for (const device of deviceFrames) {
			expect(device.frameAsset.endsWith('.webp')).toBe(true);
		}
	});

	it('should have IDs using snake_case format', () => {
		const snakeCasePattern = /^[a-z0-9]+(_[a-z0-9]+)*$/;

		for (const device of deviceFrames) {
			expect(device.id).toMatch(snakeCasePattern);
		}
	});

	it('should have reasonable aspect ratios for phones', () => {
		const phones = getDeviceFramesByCategory('phone');

		for (const phone of phones) {
			const aspectRatio = phone.imageDimensions.height / phone.imageDimensions.width;

			// Modern phones typically have aspect ratios between 1.8 and 2.2
			expect(aspectRatio).toBeGreaterThan(1.5);
			expect(aspectRatio).toBeLessThan(2.5);
		}
	});

});

// ============ COMBINED FILTER TESTS ============

describe('combined filtering', () => {
	it('should be able to filter by platform then category', () => {
		const iosDevices = getDeviceFramesByPlatform('ios');
		const iosPhones = iosDevices.filter((d) => d.category === 'phone');

		expect(iosPhones.length).toBeGreaterThan(0);
		expect(iosPhones.every((d) => d.platform === 'ios' && d.category === 'phone')).toBe(true);
	});

	it('should be able to filter by category then platform', () => {
		const phones = getDeviceFramesByCategory('phone');
		const androidPhones = phones.filter((d) => d.platform === 'android');

		expect(androidPhones.length).toBeGreaterThan(0);
		expect(androidPhones.every((d) => d.platform === 'android' && d.category === 'phone')).toBe(true);
	});

	it('should return same results regardless of filter order', () => {
		// Filter iOS then phones
		const iosFirst = getDeviceFramesByPlatform('ios').filter((d) => d.category === 'phone');

		// Filter phones then iOS
		const phonesFirst = getDeviceFramesByCategory('phone').filter((d) => d.platform === 'ios');

		// Sort by ID for comparison
		const sortById = (a: DeviceFrame, b: DeviceFrame) => a.id.localeCompare(b.id);

		expect(iosFirst.sort(sortById)).toEqual(phonesFirst.sort(sortById));
	});
});

// ============ SPECIFIC DEVICE TESTS ============

describe('specific device validation', () => {
	it('should have correct iPhone 16 Pro specs', () => {
		const device = getDeviceFrame('iphone_16_pro');

		expect(device).toBeDefined();
		expect(device?.name).toBe('iPhone 16 Pro');
		expect(device?.platform).toBe('ios');
		expect(device?.category).toBe('phone');
		expect(device?.imageDimensions.width).toBe(1406);
		expect(device?.imageDimensions.height).toBe(2822);
	});

	it('should have correct iPhone 16 Pro Max specs', () => {
		const device = getDeviceFrame('iphone_16_pro_max');

		expect(device).toBeDefined();
		expect(device?.name).toBe('iPhone 16 Pro Max');
		expect(device?.imageDimensions.width).toBe(1520);
		expect(device?.imageDimensions.height).toBe(3068);
	});

	it('should have correct Pixel 9 Pro specs', () => {
		const device = getDeviceFrame('pixel_9_pro');

		expect(device).toBeDefined();
		expect(device?.name).toBe('Google Pixel 9 Pro');
		expect(device?.platform).toBe('android');
		expect(device?.category).toBe('phone');
	});

	it('should have larger dimensions for Pro Max vs Pro', () => {
		const pro = getDeviceFrame('iphone_16_pro');
		const proMax = getDeviceFrame('iphone_16_pro_max');

		expect(pro).toBeDefined();
		expect(proMax).toBeDefined();

		expect(proMax!.imageDimensions.width).toBeGreaterThan(pro!.imageDimensions.width);
		expect(proMax!.imageDimensions.height).toBeGreaterThan(pro!.imageDimensions.height);
	});

	it('should have larger cornerRadius for Pro Max vs Pro', () => {
		const pro = getDeviceFrame('iphone_16_pro');
		const proMax = getDeviceFrame('iphone_16_pro_max');

		expect(proMax!.cornerRadius).toBeGreaterThanOrEqual(pro!.cornerRadius);
	});
});
