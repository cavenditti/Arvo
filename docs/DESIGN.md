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

### iOS Liquid Glass

On iOS 26 and later, Arvo layers the field-notebook palette behind the system's native
Liquid Glass material. The material is implemented only through `GlassSurface` in
`components/ui.tsx`, which checks the runtime API first and retains the paper treatment on
older iOS, Android, and web.

- Use glass for floating app chrome (tab bar, circular toolbar controls) and neutral content
  cards. Let the system draw the highlight, border, and refraction; only pass a very restrained
  Terra tint from `glass` in `theme.ts`.
- Keep semantic weather, health, and alert gradients opaque. Their color communicates meaning
  and must stay clear in direct sun.
- The iOS tab bar uses SF Symbols and the system material; do not substitute a custom glyph or a
  solid bar behind it.
- Native navigation titles use the system San Francisco treatment so back navigation, sheets, and
  system controls read as iOS; content typography keeps the Terra voices.
- Never animate a `GlassView`, or any of its ancestors, with `opacity`; it disables the native
  material. Use a transform or the component's native glass-style animation.
- The accessibility/system fallback is intentional. Never simulate blur with a low-contrast
  translucent surface when native glass is unavailable.

## 5. Iconography & illustration

### Bleed glyphs (`components/glyphs.tsx`)

The signature Terra element: one oversized, simple vector glyph per conditioned
card, drawn from the glyph library (sun, cloud, rain, frost, leaf, sprout, drop,
wind, thermometer). Rendered by `GlyphCard`:

- Size ≈ 1.1–1.4 × card height, anchored bottom-right with a subtle bleed (≈10–15% off
  each edge). The glyph must stay recognizable — roughly three-quarters visible, never
  cropped past half.
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

## 10. Type scale & Dynamic Type

Sizes come from the `type` tokens in theme.ts — pick a step, don't invent one:

| Token | Size | Use |
|---|---|---|
| `type.caption` | 12 | data labels, chips, meta rows — the floor |
| `type.body` | 14 | secondary prose, toast messages |
| `type.bodyLg` | 16 | primary prose, inputs, buttons |
| `type.title` | 18 | card headings |
| `type.titleLg` | 22 | section headings, priming cards |
| `type.hero` | 34 | hero numbers and screen-level display |

Rules:
- **Never disable font scaling.** Every `Text` gets `maxFontSizeMultiplier={type.maxMult}`
  (1.4) instead — layouts must survive text 40% larger. The primitives in `ui.tsx`
  already do this; screens do it for their own text.
- **12 pt is the floor for data labels.** `MonoLabel` defaults to `type.caption`; nothing
  the farmer must read in sunlight goes below it. (Supersedes the 10–11 micro-label
  sizing in §3.)

## 11. Touch targets

Gloved thumbs on a bright screen: primary actions and form controls are at least
**44 pt** tall (`touch.min`); chips and secondary tap targets at least **40 pt**
(`touch.chip`). Visual size may stay smaller — reach the minimum with padding,
`minHeight`, or `hitSlop`, never by inflating the artwork. `StatusChip`/`Pill` are
labels, not buttons; anything tappable that looks like a chip still owes the 40 pt.

## 12. Permission priming

Never let iOS ask first. Before any system permission dialog (location, camera,
photos, notifications), show a `PrimeCard`: one icon in a soft tinted circle, a plain
Italian sentence saying **why Arvo asks and what the farmer gets**, a forest-gradient
CTA that triggers the real system prompt, and an honest "Non ora" link. One card per
permission, shown at the moment the feature needs it — never a wall of requests at
first launch. If the user declines, respect it: no nagging, just a quiet path back
from the place the feature lives.

## 13. Toasts

Confirmations are quiet. After a save, a sync, a small failure: a single bottom pill
(`showToast` / `useToast`, host mounted once in the root layout), auto-dismissed in
~2.5 s, never blocking, never stacked. Success wears the primary green tint, errors
the clay tint — same chip palette as everywhere else, no new colors. A toast states
what happened ("Salvato. Si sincronizzerà da solo."), not what the system did.
Anything that needs a decision is not a toast — use a dialog or an inline banner.

## 14. Plain language first

The farmer's words lead; the agronomist's follow. Acronyms and indices (NDVI, ET₀,
GDD, p10) **never open a sentence, a title, or a chip** — the plain phrase comes
first, the technical term trails in parentheses or waits behind a "Dettagli tecnici"
disclosure: "Acqua richiesta dalle piante (ET₀)", never "ET₀". Numbers and dates are
always localized (`lib/format.ts`): "12,5 ha", "lunedì 4 agosto" — never raw ISO
dates or dot decimals in Italian copy. Plant IDs, index values and thresholds live in
the technical detail layer, not in the headline.
