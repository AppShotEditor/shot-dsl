# @appshoteditor/shot-dsl

The layout DSL behind [appshoteditor.com](https://appshoteditor.com) — framework-free building blocks
for composing **editable App Store / Play Store screenshot layouts**, plus device-frame geometry.

It is the single source of truth shared by the web editor, the Cloudflare Worker (handoff validation),
and the [App Store Screenshots agent skill](https://github.com/AppShotEditor/app-store-screenshots-skill)'s
composer — so a layout composed by the skill renders identically in the editor.

## What's inside

- **Types** — `Template`, `ScreenLayersJSON`, `LayerJSON`, `BackgroundJSON`, `CURRENT_SCHEMA_VERSION`.
- **Validators** — `validateTemplate()` (strict, error-reporting), `isValidTemplate`, `migrateScreenLayersJSON`,
  `validateDeviceScreenshot`, `isUploadedScreenshotSrc`.
- **Builders** — `makeTextLayer`, `makeImageLayer`, `makeShapeLayer`, `makeSolid/GradientBackground`,
  `makeScreen`, `makeTemplate`.
- **Device geometry** — `deviceFrames`, `getDeviceFrame`, `makeDeviceFrameLayer`, `calculateDeviceScale`,
  `computeScreenshotPlacement` (the screenshot-in-frame fit/clip math the editor uses).
- **Composer** — `composeTemplate(plan)`: a benefit/screenshot plan → a validated, device-framed `Template`
  (`composeSet(plan)` returns the same template plus a `report` with lint warnings and per-screen
  geometry). Per screen: `headline`, optional `subheadline` / `headlineColor` / `subheadlineColor`, and
  `layout` (`text-top` default, `text-bottom`, `device-bleed` — see `COMPOSE_LAYOUTS`). All geometry
  (device scale/position, font sizes, padding) is derived from the canvas size, so a plan composes to
  the same proportions at 280×608 editor units or 1320×2868 native pixels.
- **Set layout system (0.4.0)** — `solveVertical` / `NO_TANGENT` (the no-tangent rule), `focusReach`,
  `rotatedBox` (`layout-system.ts`); `makeVariants(plan)` (three concept plans, `variants.ts`); small
  colour helpers (`color.ts`).
- **Art direction (0.5.0)** — `breakLines` (balanced line breaks, `typography.ts`), tonal palettes +
  `harmonize` (one WCAG-AA text colour per set, `palette.ts`), panorama motifs (`decor.ts`), and in
  `composeSet`: the hero, accent rhythm, callouts, mascots and shadows (see "Art direction" below).

```ts
import { composeTemplate, validateTemplate } from '@appshoteditor/shot-dsl';

const template = composeTemplate({
  name: 'My App',
  screens: [
    {
      headline: 'Track every workout',
      subheadline: 'Sets, reps and rest — logged for you',
      layout: 'text-top',
      background: { type: 'gradient', gradient: { type: 'linear', colorStops: [/* … */] } },
      deviceId: 'iphone_16_pro',
      screenshot: { url: '…', width: 1179, height: 2556 }
    }
  ]
});
validateTemplate(template); // { valid: true, errors: [] }
```

## Set layout system (0.4.0)

`composeSet` lays a plan out as ONE system, the way a screenshot designer would:

1. **One system per set.** It measures every screen's text block first and reserves a text area
   for the TALLEST one (per canvas size). The headline size is fixed for the whole set
   (`HEADLINE_SIZE` × the type unit). Long copy is never shrunk: it gets a lint warning instead.
   Screens that share a canvas size, presentation, device, layout and tilt (`report.screens[i].group`)
   get the same subject scale and baseline, so copy length never moves or resizes anything.
2. **No tangents.** A device (or frameless screenshot) either clears the far edge by ≥ 4% of H or
   bleeds off it by ≥ 12% of its own height. The band in between is the "just touching" look, and
   `solveVertical` never emits it. `style.bleed` picks how a tangent is resolved:
   - `auto` (default): a device that already clears by the margin, or already bleeds decisively
     (≥ 12%, without cropping its focus band), stays as it is. Otherwise it grows toward the
     90%-of-W cap; if that's still short of a 12% bleed, "minimum disturbance" decides between
     clearing and shifting down: it clears at the near edge (no shift) when that clear scale is
     ≥ 88% of the grown/capped scale (`NO_TANGENT.clearOverShift`); otherwise it shifts down only
     as far as exactly a 12% bleed.
   - `none`: always fully visible.
   - `deep`: grows the subject toward a 25% bleed (still capped at 90% W). When growth alone can't
     reach 25% and a down-shift would be the only way to reach even 12%, the same minimum-disturbance
     rule applies: it clears at the near edge when that costs ≤ 12% of the grown/capped scale;
     otherwise it shifts down only as far as exactly a 12% bleed needs — never deeper, even though
     the target is 25%.
3. **No side tangents.** No subject is wider than 90% of W (`NO_TANGENT.maxWidth`). The part that is
   actually on the canvas keeps ≥ 5% of W from both side edges. The only side bleed is a deliberate
   panorama straddle across a seam.
4. **Focus-aware, on all four edges.** Marked `focus` band corners (`{ top, bottom }`, fractions of
   the screenshot height) always stay:
   - ≥ 2% of H inside the top and bottom edges;
   - ≥ 2% of W inside the side edges and any seam. This includes tilted subjects: their rotated
     corners are checked.

   A bleed that would crop the band is reduced, or turned into the clear-with-margin option. When a
   tilt doesn't fit the side rules, the composer first shrinks the device, or the zoom card (keeping
   its aspect), by at most 20%. After
   that it reduces the tilt in quarter steps, down to straight if needed, and warns `tilt-reduced`.
   In a group, the most restrictive focus decides for every screen. A zoom card that can't show a
   whole band warns `zoom-focus-cropped`.
5. **Room for the device.** The device must keep at least half the size it would get on this canvas
   with NO copy. That size is height-limited for tall devices on landscape canvases, such as an iMac
   on 608×380. If the text leaves less room, `composeSet` throws "copy too long for this canvas … cut
   the subheadline or headline". If even the no-copy fit is under 30% of the target width, it throws
   "device … doesn't fit a W×H canvas … use the device's own canvas", because the canvas, not the
   copy, is the problem.

Text metrics are per font (`FONT_CHAR_WIDTH`, plus character classes: capitals and m/w count
wider, i/l and punctuation narrower). They are calibrated to be conservative for every
`COMPOSE_FONTS` entry, so an estimated 2-line headline never renders as 3.

Plan additions (all optional; a 0.3.0 plan composes and validates unchanged):

| Field | Where | Meaning |
| --- | --- | --- |
| `style.presentation` | plan | `device` (default) · `frameless` (rounded screenshot + shadow) · `zoom` (magnified crop of `crop`, else the centre of the `focus` band) |
| `style.tilt`, `style.tiltScreens` | plan | Degrees (clockwise) applied only to the listed screen indices. A tilted subject prefers a deeper bleed under `auto`/`deep`, but clears instead when its scale cap (from keeping the side margins) stops it reaching a decisive bleed without a big down-shift (minimum disturbance, see above); the tilt itself is reduced (`tilt-reduced`) if it can't keep the side margins at all. |
| `style.bleed` | plan | `auto` · `none` · `deep` (see above) |
| `style.palette` | plan | `{ mode: "tonal" \| "family" \| "sequence", colors: [hex…], tone? }`. Background for screens that omit one; ONE text colour per set (see Art direction). |
| `style.panorama` | plan | `{ spans?: [[0,1], …], straddle?: true \| [screen…], decoration?: "orbs" \| "honeycomb" \| "wave" \| "none" }`. Adjacent screens share one continuous background; `straddle` picks the span-start screens whose device crosses the seam (only by ≥ 18% of it). |
| `style.hero`, `style.rhythm`, `style.callouts`, `style.shadows` | plan | 0.5.0 — see Art direction. |
| `art` | plan | 0.5.0 `[{ id, url, width, height, faces? }]` brand art (uploaded-asset URLs only). |
| `callout`, `mascot` | screen | 0.5.0 — a magnified crop of the selling element · brand art placement. |
| `style.font` | plan | One of `COMPOSE_FONTS` (the editor's font list). |
| `focus`, `crop`, `presentation`, `tilt`, `badge` | screen | Focus band · zoom crop `{x,y,w,h}` · per-screen overrides · a social-proof pill above the headline |

Output shapes:

- **Text colour (0.5.0: ONE per set).** An explicit `headlineColor` / `subheadlineColor` always
  wins. Otherwise EVERY screen takes part in choosing one set colour: `harmonize` tries a dark and a
  light candidate (a deep / pale tint of the brand hue for tonal palettes, else `#111827` / white),
  sampling every screen on a 5×7 grid. Palette / span backgrounds may be re-toned (moved away from
  the text in small steps until the worst sample passes WCAG 4.5); explicit backgrounds are sampled
  as they are and never recoloured. The candidate needing the least re-toning wins (the other only
  if it also passes on the explicit backgrounds for ≤ 0.15 more). If the set colour still can't reach
  4.5 on an explicit background, ONLY that screen gets its own best colour (a panorama span whose
  fill is explicit counts as ONE unit: one colour for the whole span, so the scene stays consistent) —
  `report.screens[i].textColorSource === "screen"` (else `"set"`, or `"plan"` for an explicit
  `headlineColor`). An explicit-only set keeps white whenever white passes (0.4.0). The headline and
  subheadline are also checked densely right behind their boxes; a screen that no colour can bring to
  4.5 warns `contrast-low` — never silent. The subheadline's brand tint is used only when it clears
  4.6 (a margin, so it never lands at 4.49).
- **Frameless / zoom** is a plain `type: 'image'` layer:
  - Its `src` is the uploaded screenshot, with `crossOrigin: 'anonymous'`.
  - It has a rounded `clipPath` Rect in the image's local space, `imageCornerRadius` (canvas units,
    the editor's corner-radius control) and a Fabric `shadow` (blur/offset in the object's own units,
    like the editor's shadow control).
  - Zoom adds Fabric `cropX`/`cropY` with `width`/`height` set to the crop size.
  - Every screen of a zoom group uses the same card box.
- **Tilt** is the device layer's `angle`. The editor rotates the screenshot with the frame on attach, on
  move/scale/rotate, and in the offscreen export.
- **Panorama** is pure DSL:
  - Each screen of a span gets a locked `Rect` of size N·W × H at `left = N·W/2 − k·W`, painted with
    the span-start screen's background.
    - A solid colour stays solid.
    - A linear gradient keeps its stops and `angle`, applied across N·W; without an `angle` it runs
      corner to corner.
    - Radial gradients and explicit `coords` throw a clear error.
  - Optional seam orbs are moved or shrunk so they never overlap either neighbour's text block, and
    dropped when there's no room.
  - With `straddle` (`true` = every span, or a list of span-start screen indices), that span's first
    device is shifted right so it crosses the seam. More than one crossing per set is lint-warned
    (`panorama-straddle-count`). A copy of it,
    named "… (continued)", is emitted on the next screen at `left − W`, below that screen's own device.
  - The straddle is only ever a rightward shift. It must keep the left side margin, and when a
    `focus` band is marked, the band stays ≥ 2% of W inside the seam. Otherwise the straddle is
    skipped (`straddle-skipped`) and the device is placed like any other screen.
  - In the editor, the halves are independent layers: moving one does not move the other.
- **Badge** is a rounded `Rect` pill plus a `Textbox` (`templateKey: 'badge'`). They sit in a badge row
  above the headline, reserved set-wide, so they never collide with the text or the device.

### Art direction (0.5.0)

- **Line breaks.** Headlines and subheadlines are set in `breakLines` lines. An explicit `\n` is ALWAYS
  a break — lines the author broke are never merged, on any device or role. Only a line (explicit or
  not) wider than the box is broken further: into the greedy line count, re-balanced (no single word
  on the last line, breaks after punctuation preferred, never after "the"/"to"/…; past 40 tokens it
  breaks greedily, so absurd copy fails fast). CJK / kana / Hangul count ~1 em per glyph and may
  break between glyphs. The breaks are emitted as `\n` in the Textbox. A single word wider than the
  box throws (Fabric can't wrap inside a word — it would widen the box past the margins).
  Subheadline: 0.5× the headline, weight 600, full opacity, tinted 18% toward the brand hue when
  that still passes AA. Text box 0.88 W.
- **Tonal palette.** `{ mode: "tonal", colors: [base, accent?], tone: "light" | "vivid" | "deep" }`:
  screen i gets tonal step i % 4 of the base hue as a vertical gradient (the hero step 0). The accent
  fills badge pills. Tonal panorama spans run one ramp through their members' tones.
- **Hero** (`style.hero`, default ON for screen 1; `false` = off): headline 1.25× (stepped down in
  0.05s — to 1× if needed — so it never has more lines than at the set size; `scale` 1–1.4), its own group with bleed `deep`, optional `layout`, `tilt`,
  `badge`, `mascot`. `report.screens[i].role` is `hero`.
- **Rhythm** (`style.rhythm: { every, treatment }`): screens where `i % every === every − 1` are
  `accent`s — `text-bottom` layout, or `callout` (a forced callout + deep bleed). All `set`-role
  screens still share one group, type size, text area, scale and baseline.
- **Callouts** (`screen.callout` crop, or `style.callouts: "auto"` from a focus band ≤ 50% tall): an
  image layer with the SAME uploaded `src` + `cropX`/`cropY`, rounded, shadowed, magnified 1.6–2.2×
  (down to 1.25× to fit), inside 3.5% side margins, between the text block and a 4% far-edge margin.
  The requested crop is automatically padded, on whichever sides have room inside the screenshot,
  before it's magnified, so the rounded corners of the card don't clip content sitting at the
  requested crop's own corners (e.g. a selection handle); a side with no room (flush against the
  screenshot edge) can still clip there. It may cover its own source slice (the pop-out), but
  it hides at most `CALLOUT_MAX_FOCUS_COVER` (35%) of the REST of the focus band: it is centred on its
  source when that allows, else moved up/down or out to a side edge (breaking out of the device), else
  made smaller; if nothing works it is skipped (`callout-skipped`). `report.screens[i].callout.focusCover`
  is the share hidden. Never on zoom cards or a straddling device.
- **Mascots** (`plan.art` + `screen.mascot` / `style.hero.mascot`): an image layer (uploaded src,
  `flipX` to face into the canvas when `faces` is given, shadow). Anchors `headline` / `device-top` /
  `device-side` / `seam` are tried in order with fallbacks at 100/85/70% size; a placement must clear
  every text line, the badge, the subheadline, the callout, every other mascot on the screen
  (including a neighbour's seam half) and the focus band's core (its outer 10% W may be overlapped).
  `seam` puts one mascot across a panorama seam, emitted on both screens (±W). Otherwise
  `mascot-skipped`.
- **Badges** keep their label at WCAG ≥ 4.5 on the pill: a solid (tonal accent) pill is toned
  toward black or white until it does; a translucent one gets fainter.
- **Shadows** (`style.shadows`, default true), tinted with the brand hue: device layers get
  `fabricData.deviceShadow = { color, blur, offsetX, offsetY }` in CANVAS units — the editor casts it
  from the frame's screenshot (a Fabric shadow on the frame PNG would fall into its transparent screen
  hole); frameless / zoom / callouts / mascots get a Fabric `shadow` in object units.
  `validateTemplate` checks `deviceShadow` (device layers only; colour ≤ 64 chars; blur 0…canvasWidth;
  offsets ±canvasWidth).
- **Panorama motif** (`decoration: "honeycomb" | "wave"`): the motif is laid out across the whole span,
  but each screen emits only ITS part (the hexagons / wave segments touching it plus a 2-stroke
  overdraw) as one locked `Path` in its own coordinates, rounded to 0.1 unit; both neighbours emit
  the same points around a seam, so it runs on continuously. (0.5.0-pre emitted the whole N·W path on
  every screen — O(N²) bytes.)
- **Handoff size.** `MAX_HANDOFF_BYTES` (256 KiB, the server's cap) and `handoffBytes(template)` (UTF-8
  size of the `{ template }` request body). The skill's `lint` / `compose` / `publish` / `variants`
  error over the cap and warn over 80%. A 30-screen phone + iPad + Mac honeycomb panorama is ≈ 166 KB.

`report.warnings` (`ComposeWarning`) flags:

- a headline over 5 words, or estimated at more than 2 lines at the set size;
- a subheadline estimated at more than 1 line;
- more than 2 tilted screens;
- a seam crossing a headline or focus band, or a straddle that can't be checked because no focus
  band is marked;
- skipped straddles, and more than one straddle per set;
- tilts reduced to keep the side margins;
- zoom crops that can't show their whole focus band;
- long badges;
- 0.5.0: a stranded last headline word (`headline-orphan`), a screen no colour can bring to AA
  (`contrast-low`), a callout that can't be magnified or placed without hiding the focus band
  (`callout-skipped`), no room for a mascot (`mascot-skipped`).

Backward compatibility (0.5.0): a 0.4.0 plan still composes, but screen 1 is now the hero (1.25×
headline, `deep` bleed, its own device pose) and devices get shadows — `style.hero: false` /
`style.shadows: false` restore the 0.4.0 look. Balanced line breaks can change where a headline
wraps, and the new warnings can make `--strict` fail for a plan that passed before.

Warnings never block composing.

`makeVariants(plan)` returns three distinct ART DIRECTIONS, intended as Product Page Optimization
test candidates. Each is named `<name> — A Brand Classic` / `— B Clean Frameless` / `— C Story Panorama`:

- **A Brand Classic:** device frames on the `vivid` tonal palette, hero with the mascot (first `art`)
  + badge, callouts (the input's explicit `style.callouts`, else `auto`), rhythm every 4 (`text-bottom`).
- **B Clean Frameless:** `light` tonal palette, full-width frameless screenshots with a `deep` bleed
  (a zoom card only for an explicit `crop` — B1), callouts (same default as A), hero at 1.3× with the mascot.
- **C Story Panorama:** `deep` tonal palette; spans = the input's `panorama.spans`, else triples and
  pairs (`panoramaRuns`); `decoration` = the input's (not `orbs`), else `wave`; a mascot crossing the
  first seam of every span but the hero's; the hero tilted (the input's `style.tilt`, or 8°); bleed
  `deep`; a straddle only if the input asks.

**Kept from the input** in every concept:
- copy (headline / subheadline / badge) and `headlineColor` / `subheadlineColor`;
- `background`, `deviceId`, `screenshot`, `focus`, `crop`, `callout`, `mascot`, `art`;
- canvas size;
- the brand colours (`style.palette.colors`; else the first screen's background colour), `style.font`,
  and `style.bleed: none`.

**Overridden:**
- every `layout` becomes `text-top` (the hero and rhythm accents differ on purpose);
- per-screen `presentation` and `tilt` are dropped;
- palette mode → `tonal` with the concept's tone; hero, rhythm, panorama per concept;
- `callouts` per concept too, but only C's is fixed (`none`) — A and B keep the input's explicit
  `style.callouts`, defaulting to `auto` only when the input leaves it unset.

## Layer order

A screen's `layers` array is **bottom → top**: index 0 is painted first (canvas add order), the last
entry is frontmost. A composed screen is `[device, headline, subheadline?]`; the editor's built-in
templates list background shapes, then the device, then text. (The editor's layers *panel* shows the
reverse — top first.)

## Device screenshots (0.3.0)

A device mockup is **one** layer. Its screenshot is a property of the device layer, at
`fabricData.screenshot`:

```json
{
  "id": "device-frame-layer-1790080000000-abc123def",
  "name": "iPhone 17 Pro Max",
  "type": "device",
  "visible": true,
  "locked": false,
  "fabricData": {
    "type": "image",
    "src": "/devices/iphone-17-pro-max.webp",
    "left": 140, "top": 438.69, "width": 1520, "height": 3068,
    "scaleX": 0.175, "scaleY": 0.175, "originX": "center", "originY": "center",
    "layerId": "device-frame-layer-1790080000000-abc123def",
    "layerType": "deviceFrame",
    "layerRole": "frame",
    "deviceFrameId": "device-frame-layer-1790080000000-abc123def",
    "deviceId": "iphone_17_pro_max",
    "deviceScale": 0.175,
    "screenshot": { "src": "/api/screenshots/<asset-id>/raw", "width": 1320, "height": 2868 }
  }
}
```

`screenshot` is `{ src, width, height, rotation? }` (`DeviceScreenshotJSON`; `rotation` ∈ 0/90/180/270).
Producers emit **no** screenshot geometry or clip path: the editor places the image under the frame
and clips it to the screen with the same code path it uses when a user drops a screenshot onto a
frame (`computeScreenshotPlacement`), so the screenshot belongs to the frame (it is not a separate
layer). `validateTemplate` requires `src` to be an uploaded-asset URL (`/api/screenshots/<id>/raw`) —
external, protocol-relative and `data:` URLs are rejected. It also requires every device layer to have a
known `deviceId` and a frame-asset `src` (`/devices/<name>.webp|png`), and rejects duplicate layer ids
or `deviceFrameId`s within a screen. Every other image reference in a handoff (image layers, pattern
`fill.source`, nested objects) must be an uploaded screenshot or a `/devices/` asset. Frame metadata
(`layerRole: 'frame'`, `deviceFrameId`, `deviceId`, `deviceScale`) is only allowed on device layers,
`layerRole: 'screenshot'` only on legacy image layers, and editor-internal props
(`EDITOR_INTERNAL_PROPS`, e.g. `pendingScreenshot`) are rejected everywhere, as are `__proto__` /
`constructor` / `prototype` keys at any depth (`FORBIDDEN_KEYS`).

`computeScreenshotPlacement` centres the screenshot on the frame's screen bounds; the screen-centre
offset scales with the frame's scale *relative to* `deviceScale` (0.2.x editors multiplied by the
absolute frame scale, misplacing off-centre screens such as MacBooks by a few canvas units).

**Legacy (≤ 0.2.0):** screenshots were a separate `type: 'image'` layer with
`fabricData.layerRole: 'screenshot'` and a `deviceFrameId` matching its frame, placed directly below
the frame. `validateTemplate` still accepts that shape (its `src` must also be an uploaded-asset URL)
and the editor converts it on import.
`makeDeviceFrameLayers()` (which returned `{ screenshot, frame }`) was replaced by
`makeDeviceFrameLayer()` (returns the single device layer).

> Consumers: a template in the 0.3.0 shape needs an editor that understands `fabricData.screenshot`
> (appshoteditor.com with the matching importer). 0.4.0 adds no new layer shapes that the 0.3.0 validator
> or importer would reject: frameless/zoom are ordinary image layers, and panorama and badges are
> ordinary shape and text layers. 0.5.0 likewise: callouts and mascots are image layers with
> uploaded-asset srcs, motifs are `Path` shape layers — all accepted by the 0.4.0 validator (and by
> 0.5.0's, which additionally checks the shape of `deviceShadow`). Only the device shadow needs a
> 0.5.0-aware editor to render; older editors ignore it.

Zero runtime dependencies. The `schemaVersion` is the compatibility contract between producers and the editor.

> Intended for use via a bundler (Vite, esbuild, etc.). Device `frameAsset` values are URL paths the
> editor serves; this package ships only the geometry, not the frame images.

## Development

This repository mirrors the package's source in the App Shot Editor codebase, and it is updated on each release. Issues and pull requests are welcome; accepted changes are applied upstream and appear here with the next sync.

The package ships TypeScript source (no build step), so use it through a bundler such as Vite or esbuild. To run the tests:

```bash
npx vitest@5 run
```

## License

MIT © Furvur Inc
