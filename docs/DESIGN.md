# Terra — the Arvo design language

Terra is how Arvo looks and feels: **organic precision**. The product reads like a
well-kept field notebook — warm paper, growing greens, sun and clay — with data set
in a cool, exact monospace. Every surface should feel grown, not generated.

Everything here is enforced through tokens in `app/src/theme.ts` and primitives in
`app/src/components/ui.tsx` + `app/src/components/glyphs.tsx`. If a screen needs
something this document doesn't provide, extend the tokens first, then use them.

---

## 1. Principles

1. **Grounded.** Colors come from the land: paper, soil, leaf, straw, clay, sky.
   No neon, no pure grey, no pure black.
2. **Legible in the field.** High text contrast, generous touch targets, one glance
   per fact. Decoration never competes with data.
3. **Data is cool, everything else is warm.** Numbers, dates, meta rows are mono and
   precise. Titles and prose are warm and human.
4. **Weather and health paint the backdrop.** When a surface represents a condition
   (a hot day, a healthy field, an attention alert), its background says so with a
   gradient — softly. Meaning first: never gradient for decoration alone.
5. **Illustration over indication.** A card may carry one oversized vector glyph
   bleeding off its corner, toned into the backdrop. Small abstract markers are
   banned — see the No-Dots rule.

---

## 2. Color

### Foundations (unchanged tokens in `colors`)

| Token | Value | Use |
|---|---|---|
| `bg` | `#F2F1EC` | app paper |
| `card` | `#FBFAF7` | raised surfaces |
| `cardAlt` | `#F6F5F2` | inset panels |
| `text` | `#1B1E1A` | ink |
| `textMuted` | `#5C625C` | secondary ink |
| `textFaint` | `#8A8F86` | tertiary ink, mono meta |
| `border` / `borderSoft` | `#E4E1D7` / `#EDECE7` | hairlines |
| `primary` / `primaryDark` | `#234B34` / `#1F4430` | forest — actions |
| `accent` | `#A5432B` | clay — attention |
| `warning` | `#9A6A1E` | straw — watch |
| `info` | `#5B8F8A` | eucalyptus — neutral info |
| `success` | `#3F7D45` | leaf — healthy |

### Brand greens (logo only)

`#008000` (field green), `#00AA00` (bright leaf), stem gradient `#00CF00 → #008000`.
The logo always keeps these original colors on a white or paper tile. Never recolor
the mark, never place it on forest green.

### Semantic backdrops — `gradients` in theme.ts

Gradients are **two close stops of the same temperature**, rendered diagonally
(`start {x:0,y:0} → end {x:0.9,y:1}` unless noted). Subtle: if a screenshot in
grayscale shows an obvious band, it's too strong.

| Token | Stops | Meaning |
|---|---|---|
| `gradients.paper` | `#FBFAF7 → #F3F2EA` | default card wash |
| `gradients.meadow` | `#EAF1E3 → #FAF9F1` | healthy / growth |
| `gradients.straw` | `#F7EFD7 → #FBF8EE` | watch / caution |
| `gradients.clay` | `#F6E2D9 → #FBF6F1` | attention / heat risk |
| `gradients.eucalyptus` | `#E2EDEB → #F6F8F5` | info / neutral advisory |
| `gradients.skyClear` | `#FBEFC9 → #F4F5E7` | clear, warm day |
| `gradients.skyHot` | `#F6DEBB → #F8EFDC` | heat (t_max ≥ 32 °C) |
| `gradients.skyRain` | `#D9E6E7 → #EFF3F0` | rain expected |
| `gradients.skyCloud` | `#EBECE6 → #F5F5F0` | overcast / mild |
| `gradients.skyFrost` | `#E2ECF0 → #F2F6F5` | frost risk (t_min ≤ 0) |
| `gradients.forest` | `#2C5A40 → #1F4430` | primary CTAs, hero buttons |

Rules:
- A backdrop gradient must **mean** something (severity, weather condition,
  health). Plain content stays on `card` or `gradients.paper`.
- Text on light gradients uses the normal ink scale. On `forest`, use `onPrimary`.
- Severity mapping: critical → `clay`, warning → `straw`, info → `eucalyptus`,
  healthy/ok → `meadow`.
- Weather mapping (per day): frost → `skyFrost`; rain ≥ 1 mm → `skyRain`;
  t_max ≥ 32 → `skyHot`; t_max ≥ 20 → `skyClear`; else `skyCloud`.

## 3. Typography

Three voices, loaded in the root layout, exposed as `fonts` in theme.ts:

| Role | Family | Token |
|---|---|---|
| Display — screen titles, card headings, parcel names | **Fraunces SemiBold** | `fonts.display` |
| Display strong — hero headings | **Fraunces Bold** | `fonts.displayBold` |
| Body — prose, labels, buttons | **Manrope** 400/500/600/700 | `fonts.body`, `fonts.bodyMedium`, `fonts.bodySemiBold`, `fonts.bodyBold` |
| Data — numbers, dates, units, meta rows, table headers | **IBM Plex Mono** 400/600 | `fonts.mono`, `fonts.monoSemiBold` |

Hard rules:
- **Never set `fontWeight` alongside these families** — native ignores it and web
  fakes it. Pick the weight via the family token.
- Big numbers (NDVI heroes, temperatures, GDD) are always mono, and units/labels
  around them are `MonoLabel` (uppercase, letter-spaced).
- Fraunces is for headings only — never for body text or inside chips/buttons.
- Sizes: display 28/22/17 (screen/section/card), body 15/13, mono data 44/18/13,
  micro-labels 10–11.

## 4. Shape & elevation

- Radius: `sm 8, md 12, lg 16, xl 20 (hero cards), pill 999`.
- Hairline borders (`border`/`borderSoft`) define edges; shadows only on floating
  elements (FAB, map cards, dropdowns) — soft, `opacity ≤ 0.18`.
- Cards never nest more than twice (page → card → inset tile).

## 5. Iconography & illustration

### Bleed glyphs (`components/glyphs.tsx`)

The signature Terra element: one oversized, simple vector glyph per conditioned
card, drawn from the glyph library (sun, cloud, rain, frost, leaf, sprout, drop,
wind, thermometer). Rendered by `GlyphCard`:

- Size ≈ 1.1–1.4 × card height, anchored bottom-right, bleeding off two edges.
- Tone-on-tone: same hue family as the backdrop, `opacity 0.12–0.2`. Never a
  second hue, never above the content (content wraps in a zIndex view).
- One glyph per card, only when the card *is* the condition (a weather day, an
  advisory, a health summary). Tables, forms, and lists stay glyph-free.

### UI icons

Ionicons outline set, 16–20 px, `textMuted` (or context color). Icons accompany a
label; icon-only buttons need `accessibilityLabel`.

### The No-Dots rule

**A bare colored dot is never a state indicator.** State is carried by, in order
of preference:
1. the surface itself (semantic gradient),
2. a labeled chip (`StatusChip` / `Pill`),
3. a small glyph in a tinted 24–28 px rounded-square badge (`GlyphBadge`).

This applies to severity dots, condition dots, legend dots, "online" dots — all of
them. Legends label swatches of the actual fill they explain (a gradient square is
fine); notification counts use a numeric badge, not a dot.

## 6. Components (in `ui.tsx`)

- `Card` — plain paper card.
- `TintCard` — gradient card; pass a `gradients.*` recipe (or severity via helper).
- `GlyphCard` — TintCard + one bleed glyph (`glyph`, `glyphColor`, `glyphSize`).
- `StatusChip` / `Pill` — labeled state chips (Manrope 700, 11 px, tinted bg).
- `GlyphBadge` — small tinted rounded square with a glyph, replaces icon dots.
- `MonoLabel` / `MonoValue` / `Delta` / `NdviSwatch` — data voice.
- Buttons: primary = `gradients.forest` pill (radius lg), text `onPrimary`,
  Manrope Bold; secondary = card bg + border.

## 7. Logo

Original colors on light tile (`Logo` component):
- `tile` variant: white `#FFFFFF` tile, hairline border, original-color mark.
- `plain` variant: original-color mark straight on paper.
Clearspace ≥ 25% of mark height. Never cream/forest recolors, never on `forest`.

## 8. Voice

Sentence case everywhere (chips/labels may use uppercase mono). Agronomic guidance
is decision support — suggest, don't prescribe. Italian-first copy, English parity.

## 9. Don'ts

- ✗ Colored dots for state/severity/legend (see 5).
- ✗ `fontWeight` with Terra families; system fonts anywhere.
- ✗ Decorative gradients on unconditioned surfaces; > 2 hues per gradient.
- ✗ Glyphs above content, glyphs in tables/forms, more than one glyph per card.
- ✗ Left-border accent stripes (replaced by gradient surfaces — never bring back).
- ✗ Recolored or dark-tile logo.
