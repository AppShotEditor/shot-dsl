import type { DeviceClass } from './types';

// =============================================================================
// DEVICE FRAME DEFINITIONS
// =============================================================================
//
// HOW TO ADD/EDIT A DEVICE:
//
// 1. Open the device PNG in Affinity Designer (or similar)
// 2. Get the document size → imageDimensions: { width, height }
// 3. Draw a rectangle over the transparent screen area
// 4. From Transform panel, copy X, Y, W, H → screenBounds: { x, y, width, height }
// 5. Add entry below
//
// =============================================================================

export interface DeviceFrame {
	id: string;
	name: string;
	platform: 'ios' | 'android' | 'macos' | 'windows';
	category: 'phone' | 'tablet' | 'desktop' | 'laptop';
	frameAsset: string; // Path to PNG with transparent screen
	imageDimensions: { width: number; height: number }; // Size of the PNG
	screenBounds: { x: number; y: number; width: number; height: number }; // Screen area within PNG
	cornerRadius: number; // Corner radius of the screen in pixels (unscaled)
	/**
	 * Explicit device GROUP for frames that do not fit the platform + category rule (e.g. the two
	 * iPhone Duo displays, which each need their own App Store size). A frame that sets this also
	 * gets its editor canvas derived from its screen aspect (`canvasDimsForDevice`).
	 */
	deviceClass?: DeviceClass;
}

// =============================================================================
// DEVICE LIST - Edit this array to add/modify devices
// =============================================================================

export const deviceFrames: DeviceFrame[] = [
	// -------------------------------------------------------------------------
	// iOS PHONES
	// -------------------------------------------------------------------------
	{
		id: 'iphone_16_pro',
		name: 'iPhone 16 Pro',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-16-pro.webp',
		imageDimensions: { width: 1406, height: 2822 },
		// Screen centered within frame: (1406-1212)/2=97, (2822-2618)/2=102
		screenBounds: { x: 97, y: 100, width: 1212, height: 2624 },
		cornerRadius: 120 // Adjust to match device screen corners
	},
	{
		id: 'iphone_16_pro_max',
		name: 'iPhone 16 Pro Max',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-16-pro-max.webp',
		imageDimensions: { width: 1520, height: 3068 },
		// Screen centered within frame: (1520-1310)/2=105, (3068-2846)/2=111
		screenBounds: { x: 100, y: 100, width: 1320, height: 2870 },
		cornerRadius: 140 // Slightly larger than 16 Pro
	},
	{
		id: 'iphone_16',
		name: 'iPhone 16',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-16.webp',
		imageDimensions: { width: 1379, height: 2756 },
		screenBounds: { x: 95, y: 98, width: 1189, height: 2563 },
		cornerRadius: 118
	},
	{
		id: 'iphone_16_plus',
		name: 'iPhone 16 Plus',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-16-plus.webp',
		imageDimensions: { width: 1490, height: 2996 },
		screenBounds: { x: 103, y: 106, width: 1284, height: 2786 },
		cornerRadius: 128
	},
	{
		id: 'iphone_17_pro',
		name: 'iPhone 17 Pro',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-17-pro.webp',
		imageDimensions: { width: 1406, height: 2822 },
		screenBounds: { x: 97, y: 100, width: 1212, height: 2624 },
		cornerRadius: 120
	},
	{
		id: 'iphone_17_pro_max',
		name: 'iPhone 17 Pro Max',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-17-pro-max.webp',
		imageDimensions: { width: 1520, height: 3068 },
		screenBounds: { x: 100, y: 100, width: 1320, height: 2870 },
		cornerRadius: 140
	},
	{
		id: 'iphone_air',
		name: 'iPhone Air',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-air.webp',
		imageDimensions: { width: 1490, height: 2996 },
		screenBounds: { x: 103, y: 106, width: 1284, height: 2786 },
		cornerRadius: 128
	},
	// iPhone Duo (foldable). Original vector drawings (static/devices/iphone-duo-*.svg, rasterised
	// to .png/.webp). The screen opening is EXACTLY the App Store size, so screenshots fit 1:1.
	// No crease is drawn over the inner (folding) display.
	{
		id: 'iphone_duo_inner',
		name: 'iPhone Duo (inner 7.6")',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-duo-inner.webp',
		imageDimensions: { width: 2183, height: 3029 },
		screenBounds: { x: 88, y: 88, width: 2007, height: 2853 },
		cornerRadius: 120,
		deviceClass: 'iphone_duo_inner'
	},
	{
		id: 'iphone_duo_outer',
		name: 'iPhone Duo (outer 5.4")',
		platform: 'ios',
		category: 'phone',
		frameAsset: '/devices/iphone-duo-outer.webp',
		imageDimensions: { width: 1574, height: 2210 },
		screenBounds: { x: 88, y: 88, width: 1398, height: 2034 },
		cornerRadius: 140,
		deviceClass: 'iphone_duo_outer'
	},

	// -------------------------------------------------------------------------
	// ANDROID PHONES
	// -------------------------------------------------------------------------
	{
		id: 'pixel_9_pro',
		name: 'Google Pixel 9 Pro',
		platform: 'android',
		category: 'phone',
		frameAsset: '/devices/pixel-9-pro.webp',
		imageDimensions: { width: 1620, height: 3136 },
		screenBounds: { x: 112, y: 111, width: 1396, height: 2916 },
		cornerRadius: 135
	},
	{
		id: 'pixel_9_pro_xl',
		name: 'Google Pixel 9 Pro XL',
		platform: 'android',
		category: 'phone',
		frameAsset: '/devices/pixel-9-pro-xl.webp',
		imageDimensions: { width: 1684, height: 3272 },
		screenBounds: { x: 116, y: 116, width: 1452, height: 3043 },
		cornerRadius: 140
	},

	// -------------------------------------------------------------------------
	// iPadOS TABLETS
	// -------------------------------------------------------------------------
	{
		id: 'ipad_pro_13_m4',
		name: 'iPad Pro 13" (M4)',
		platform: 'ios',
		category: 'tablet',
		frameAsset: '/devices/ipad-pro-13-m4.webp',
		imageDimensions: { width: 2264, height: 2952 },
		screenBounds: { x: 100, y: 100, width: 2064, height: 2752 },
		cornerRadius: 40
	},
	{
		id: 'ipad_pro_11_m4',
		name: 'iPad Pro 11" (M4)',
		platform: 'ios',
		category: 'tablet',
		frameAsset: '/devices/ipad-pro-11-m4.webp',
		imageDimensions: { width: 1868, height: 2620 },
		screenBounds: { x: 100, y: 116, width: 1668, height: 2388 },
		cornerRadius: 40
	},
	{
		id: 'ipad_air_13',
		name: 'iPad Air 13"',
		platform: 'ios',
		category: 'tablet',
		frameAsset: '/devices/ipad-air-13.webp',
		imageDimensions: { width: 2248, height: 2932 },
		screenBounds: { x: 100, y: 100, width: 2048, height: 2732 },
		cornerRadius: 40
	},
	{
		id: 'ipad_air_11',
		name: 'iPad Air 11"',
		platform: 'ios',
		category: 'tablet',
		frameAsset: '/devices/ipad-air-11.webp',
		imageDimensions: { width: 1880, height: 2600 },
		screenBounds: { x: 120, y: 120, width: 1640, height: 2360 },
		cornerRadius: 40
	},
	{
		id: 'ipad_mini_7',
		name: 'iPad mini 7',
		platform: 'ios',
		category: 'tablet',
		frameAsset: '/devices/ipad-mini-7.webp',
		imageDimensions: { width: 1888, height: 2666 },
		screenBounds: { x: 200, y: 200, width: 1488, height: 2266 },
		cornerRadius: 40
	},

	// -------------------------------------------------------------------------
	// macOS LAPTOPS
	// -------------------------------------------------------------------------
	{
		id: 'macbook_air_13',
		name: 'MacBook Air 13"',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-air-13.webp',
		imageDimensions: { width: 3260, height: 2164 },
		screenBounds: { x: 350, y: 306, width: 2560, height: 1608 },
		cornerRadius: 20
	},
	{
		id: 'macbook_air_13_menu_bar',
		name: 'MacBook Air 13" (Menu Bar)',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-air-13-menu-bar.webp',
		imageDimensions: { width: 3260, height: 2164 },
		screenBounds: { x: 350, y: 312, width: 2560, height: 1602 },
		cornerRadius: 20
	},
	{
		id: 'macbook_air_15',
		name: 'MacBook Air 15"',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-air-15.webp',
		imageDimensions: { width: 3580, height: 2364 },
		screenBounds: { x: 350, y: 306, width: 2880, height: 1808 },
		cornerRadius: 20
	},
	{
		id: 'macbook_air_15_menu_bar',
		name: 'MacBook Air 15" (Menu Bar)',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-air-15-menu-bar.webp',
		imageDimensions: { width: 3580, height: 2364 },
		screenBounds: { x: 350, y: 308, width: 2880, height: 1806 },
		cornerRadius: 20
	},
	{
		id: 'macbook_pro_14',
		name: 'MacBook Pro 14"',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-pro-14.webp',
		imageDimensions: { width: 3944, height: 2564 },
		screenBounds: { x: 461, y: 364, width: 3022, height: 1900 },
		cornerRadius: 20
	},
	{
		id: 'macbook_pro_14_menu_bar',
		name: 'MacBook Pro 14" (Menu Bar)',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-pro-14-menu-bar.webp',
		imageDimensions: { width: 3824, height: 2564 },
		screenBounds: { x: 401, y: 374, width: 3022, height: 1890 },
		cornerRadius: 20
	},
	{
		id: 'macbook_pro_16',
		name: 'MacBook Pro 16"',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-pro-16.webp',
		imageDimensions: { width: 4340, height: 2860 },
		screenBounds: { x: 442, y: 377, width: 3456, height: 2170 },
		cornerRadius: 20
	},
	{
		id: 'macbook_pro_16_menu_bar',
		name: 'MacBook Pro 16" (Menu Bar)',
		platform: 'macos',
		category: 'laptop',
		frameAsset: '/devices/macbook-pro-16-menu-bar.webp',
		imageDimensions: { width: 4340, height: 2860 },
		screenBounds: { x: 442, y: 389, width: 3456, height: 2158 },
		cornerRadius: 20
	},

	// -------------------------------------------------------------------------
	// macOS DESKTOPS
	// -------------------------------------------------------------------------
	{
		id: 'imac_24',
		name: 'iMac 24"',
		platform: 'macos',
		category: 'desktop',
		frameAsset: '/devices/imac-24.webp',
		imageDimensions: { width: 4880, height: 5720 },
		screenBounds: { x: 200, y: 1600, width: 4480, height: 2520 },
		cornerRadius: 0
	},
	{
		id: 'studio_display',
		name: 'Studio Display',
		platform: 'macos',
		category: 'desktop',
		frameAsset: '/devices/studio-display.webp',
		imageDimensions: { width: 5520, height: 4316 },
		screenBounds: { x: 200, y: 200, width: 5120, height: 2880 },
		cornerRadius: 0
	},
	{
		id: 'pro_display_xdr',
		name: 'Pro Display XDR',
		platform: 'macos',
		category: 'desktop',
		frameAsset: '/devices/pro-display-xdr.webp',
		imageDimensions: { width: 6416, height: 4865 },
		screenBounds: { x: 200, y: 200, width: 6016, height: 3384 },
		cornerRadius: 0
	}
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getDeviceFrame(id: string): DeviceFrame | undefined {
	return deviceFrames.find((d) => d.id === id);
}

export function getDeviceFramesByPlatform(platform: DeviceFrame['platform']): DeviceFrame[] {
	return deviceFrames.filter((d) => d.platform === platform);
}

export function getDeviceFramesByCategory(category: DeviceFrame['category']): DeviceFrame[] {
	return deviceFrames.filter((d) => d.category === category);
}

/**
 * Map a device-frame id to its device GROUP (multi-device), using the frame's platform + category.
 * Returns null for an unknown id. Kept in sync with the app's `device-groups.ts` mapping.
 */
export function deviceClassForDeviceId(deviceId: string): DeviceClass | null {
	const frame = getDeviceFrame(deviceId);
	if (!frame) return null;
	if (frame.deviceClass) return frame.deviceClass;
	if (frame.platform === 'ios') return frame.category === 'tablet' ? 'ipad_13' : 'iphone_6_9';
	if (frame.platform === 'android') return 'android_phone';
	if (frame.platform === 'macos' || frame.platform === 'windows') return 'macbook';
	return null;
}
