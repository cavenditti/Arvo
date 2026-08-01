# UX Revamp — agent coordination contract (2026-08-01)

You are one of ~17 agents executing the iOS UX revamp **in parallel in a shared working tree**.
Read `docs/AGENTS.md` first (its Golden rules apply unless overridden here), plus `docs/DESIGN.md`
(authoritative design language) and `docs/API.md` (REST contract).

Mission: turn the Tier-0 app into something a **non-technical Italian farmer** trusts in the first
ten minutes. Three systemic fixes drive everything: (1) group alert noise into events, (2) one
consistent status voice across screens, (3) plain language first — jargon demoted behind
disclosures. Plus: push notifications, App Store readiness, offline resilience, field usability.

## Golden rules (this run)

1. **Touch only files you own** (§Ownership). Everything else is read-only. No exceptions —
   if blocked by a file you don't own, implement your side against the contract below and record
   the gap in your report.
2. **Never edit** `app/package.json`, `backend/crates/*/Cargo.toml`, lockfiles. Every dependency
   you need is already installed: `expo-notifications`, `expo-localization`, `expo-haptics`,
   `expo-sharing`, `expo-local-authentication`, `@react-native-community/datetimepicker`,
   `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister`.
3. **i18n protocol (overrides AGENTS.md):** only the `copy-i18n` agent edits
   `app/src/i18n/it.json` / `en.json`. Everyone else: use `t('ns.key')` for keys listed in
   §Copy spec (they WILL exist after wave 1); for keys you invent, call
   `t('ns.key', { defaultValue: '<Italian copy>' })` AND append the key to
   `app/src/i18n/pending/<your-agent-name>.json` as `{"ns.key": {"it": "...", "en": "..."}}`.
   The orchestrator merges pending files at the end.
4. **No git commands, no `npm install`, no `expo start`, no killing processes, no `rm -rf`.**
   Deleting a single file you own (e.g. replacing it) is allowed via `rm <file>`.
5. Verify your slice before reporting: app agents `cd app && npx tsc --noEmit` (and
   `npx eslint <your files>` if quick); backend agent `cargo check -p arvo-api` then
   `cargo clippy -p arvo-api --all-targets -- -D warnings` and `cargo test -p arvo-core`.
   A tsc error caused ONLY by a peer-owned file (route/module not yet created) is acceptable —
   note it in your report; everything in your own files must be clean.
6. Design language is law (`docs/DESIGN.md`): Fraunces display / Manrope body / IBM Plex Mono data
   via `fonts` tokens — **never `fontWeight`** (weight = family token). **Never** colored status
   dots or left-border accents. Use `theme.ts` tokens (`colors`, `spacing`, `radius`, `fonts`,
   and the new `type` scale + `touch` constants after wave 1). Gradients via theme helpers.
7. Copy tone (Italian primary): informal **tu**, plain words, short sentences. Acronyms/indices
   (NDVI, ET₀, GDD, p10) NEVER lead — plain phrase first, technical term in parentheses or behind
   a "details" disclosure. Dates in prose are localized via `date-fns` (`d MMMM`, `EEEE d MMMM`) —
   never ISO `YYYY-MM-DD` in user-visible text. Numbers via `Intl.NumberFormat('it-IT'|'en-US')`
   (Hermes supports it): `12,5 ha` not `12.5 ha`. English mirror must be idiomatic, not literal.
8. Accessibility floor for every screen you touch: `accessibilityRole`/`accessibilityLabel` on
   interactive elements; text you touch gets `maxFontSizeMultiplier={type.maxMult}` (from theme)
   instead of disabling scaling; touch targets ≥ 44pt (use `touch.min`) for primary actions,
   ≥ 40pt for chips.
9. Keep web (`*.web.tsx`, `components/web/*`) compiling but do NOT restyle it. Platform-forked
   files: same-extension forks only (`.tsx` + `.web.tsx`); remember Metro resolves plain `Foo.ts`
   before `Foo.web.tsx`/`Foo.native.tsx` — keep the existing `.d.ts` shim pattern for forked
   components.
10. Report format (final message): `## Done` bullet list mapped to your numbered tasks ·
    `## Files changed` · `## Checks` (commands + outcomes) · `## Gaps/Notes` (incl. pending i18n,
    contract mismatches, TODOs left in code).

## Waves

- **Wave 1 (foundations):** `copy-i18n`, `foundation-ui`, `status-pipeline`, `alert-grouping`,
  `backend-core`. Their exports/keys are contracts for wave 2.
- **Wave 2 (surfaces):** `shell-nav`, `push-app`, `offline-persist`, `map-native`, `parcel-flow`,
  `parcel-detail`, `dashboard`, `capture-observe`, `plants-screens`, `auth-flow`, `ios-widget`,
  `docs-business`.

## Ownership

| Agent | Owns (create/edit) |
|-------|--------------------|
| copy-i18n | `app/src/i18n/it.json`, `app/src/i18n/en.json`, `app/src/i18n/index.ts` |
| foundation-ui | `app/src/theme.ts`, `app/src/components/ui.tsx`, `app/src/components/DateField.tsx` (new), `app/src/components/Toast.tsx` (new), `app/src/components/PrimeCard.tsx` (new), `app/src/components/StaleBanner.tsx` (new), `app/src/lib/haptics.ts` (new), `app/src/lib/format.ts` (new), `docs/DESIGN.md` |
| status-pipeline | `app/src/features/insights/status.ts` (new), `app/src/features/insights/format.ts` |
| alert-grouping | `app/src/features/insights/grouping.ts` (new), `app/src/components/AlertList.tsx`, `app/src/app/(tabs)/alerts.tsx` |
| backend-core | `backend/migrations/0130_push_and_reset.sql` (new), `backend/crates/api/src/modules/devices.rs` (new), `backend/crates/api/src/push.rs` (new), `backend/crates/api/src/modules/auth.rs`, `backend/crates/api/src/modules/mod.rs`, `backend/crates/api/src/routes.rs`, `backend/crates/api/src/config.rs`, `backend/crates/api/src/jobs/detect.rs` (push hook only), `docs/API.md` |
| shell-nav | `app/src/app/_layout.tsx`, `app/src/app/(tabs)/_layout.tsx`, `app/app.json`, `app/eas.json` (new), `app/locales/it.json` (new, iOS InfoPlist strings) |
| push-app | `app/src/notifications/` (new dir: `push.ts`, `prefs.ts`), `app/src/app/(tabs)/settings.tsx` |
| offline-persist | `app/src/offline/persist.ts` (new), `app/src/offline/queue.ts`, `app/src/api/client.ts` |
| map-native | `app/src/components/MapView.native.tsx`, `app/src/components/map/mapHtml.ts`, `app/src/components/types.ts`, `app/src/app/(tabs)/map.tsx` |
| parcel-flow | `app/src/app/parcel/new.tsx`, `app/src/features/parcels/crops.ts`, `app/src/features/parcels/hooks.ts`, `app/src/lib/geocode.ts` (new) |
| parcel-detail | `app/src/app/parcel/[id].tsx`, `app/src/components/WeatherPanel.tsx`, `app/src/app/(tabs)/weather.tsx`, `app/src/features/weather/merge.ts` (new) |
| dashboard | `app/src/app/(tabs)/index.tsx` |
| capture-observe | `app/src/app/observation/new.tsx`, `app/src/app/scouting.tsx` (new — list moves here), `app/src/app/(tabs)/scouting.tsx` (becomes stub), `app/src/app/capture/new.tsx` (light), `app/src/lib/geo.ts` (new) |
| plants-screens | `app/src/app/(tabs)/plants.tsx`, `app/src/app/plant/[id].tsx` |
| auth-flow | `app/src/app/login.tsx`, `app/src/app/register.tsx`, `app/src/app/forgot-password.tsx` (new), `app/src/app/legal/` (new: `privacy.tsx`, `terms.tsx`), `app/src/app/security.tsx` (new), `app/src/auth/` (all) |
| ios-widget | `app/targets/` (new dir), `docs/IOS-WIDGET.md` (new) |
| docs-business | `docs/BUSINESS.md` (new), `docs/PHASE0.md` (§4.8 backlog additions), `README.md` |

Spine files NOT owned by anyone this run (read-only for all): `app/src/api/types.ts`
(in-flight cadastre work — additive edits allowed ONLY by backend-consuming agents if a response
type is missing, keep additive), `backend/crates/api/src/error.rs`, `backend/crates/api/src/util.rs`.

## Frozen module contracts (wave 1 → wave 2)

`app/src/theme.ts` additions (foundation-ui):
```ts
export const type = { caption: 12, body: 14, bodyLg: 16, title: 18, titleLg: 22, hero: 34, maxMult: 1.4 } as const;
export const touch = { min: 44, chip: 40 } as const;
```

`app/src/lib/format.ts` (foundation-ui):
```ts
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string; // locale-aware
export function formatHectares(ha: number): string;        // "12,5 ha"
export function formatDay(dateIso: string): string;        // "lunedì 4 agosto"
export function formatShortDay(dateIso: string): string;   // "lun 4 ago"
export function formatTime(ts: number | string): string;   // "12:30"
```

`app/src/lib/haptics.ts` (foundation-ui): `selection() success() warning() error()` — no-op on web.

`app/src/components/Toast.tsx` (foundation-ui):
```ts
export function ToastHost(): JSX.Element;                  // mounted once by shell-nav in root layout
export function useToast(): { show(o: { message: string; kind?: 'success'|'info'|'error' }): void };
export function showToast(o: { message: string; kind?: 'success'|'info'|'error' }): void; // imperative, safe anywhere
```

`app/src/components/DateField.tsx` (foundation-ui): props
`{ label: string; value: string | null; onChange(v: string | null): void; minimumDate?: Date; maximumDate?: Date }`
— native `@react-native-community/datetimepicker`, stores ISO `YYYY-MM-DD`, displays localized.
Web fallback: `<input type="date">`-style TextInput (keep it compiling, minimal).

`app/src/components/PrimeCard.tsx` (foundation-ui): props
`{ icon: keyof typeof Ionicons.glyphMap; titleKey: string; bodyKey: string; ctaKey: string; laterKey?: string; onAccept(): void; onLater?(): void }`
— the standard permission-priming card shown BEFORE any system permission dialog.

`app/src/components/StaleBanner.tsx` (foundation-ui):
`{ updatedAt?: number | null }` → renders nothing when online+fresh(<10 min); otherwise
"Aggiornato {{time}}" pill, plus offline pill when NetInfo reports offline.
Also export `useOnlineStatus(): boolean`.

`app/src/features/insights/status.ts` (status-pipeline):
```ts
export type TrendDirection = 'up' | 'flat' | 'down';
export interface FieldTrend { delta: number | null; direction: TrendDirection; labelKey: string }
export function trendFromSeries(points: { date: string; value: number | null }[], windowDays?: number): FieldTrend; // default 7
export type StatusLevel = 'ok' | 'watch' | 'attention';
export interface FieldStatus { level: StatusLevel; chipKey: string; headlineKey: string; partial: boolean }
export function deriveFieldStatus(i: { score: number | null; trend: FieldTrend | null; openAlertEvents: number; coverage?: number | null }): FieldStatus;
```
Rules: `openAlertEvents > 0` caps level at `watch` minimum (never 'ok' headline while alerts are
open); severe combinations → `attention`; `coverage != null && coverage < 3` → `partial: true`.
ALL screens must derive chip + headline + trend from these two functions only.

`app/src/features/insights/grouping.ts` (alert-grouping):
```ts
export interface AlertEvent {
  key: string; kind: string; severity: string; parcelId: string | null;
  count: number; latestAt: string; alerts: Alert[];
  titleKey: string; titleParams: Record<string, unknown>;
  bodyKey: string; bodyParams: Record<string, unknown>;
  techDetail: string | null;   // e.g. "NDVI 0,41 · −23% · R12-P14, R08-P20, …"
}
export function groupAlerts(alerts: Alert[], parcelName?: (id: string | null) => string): AlertEvent[];
export function countAlertEvents(alerts: Alert[]): number;  // badge number
```
Group key: `kind + parcelId + calendar day(created_at)`. Plain-language title/body lead; plant IDs
and index values go ONLY into `techDetail`.

`app/src/notifications/push.ts` (push-app):
```ts
export function setupNotifications(): void;   // idempotent; handler + iOS categories
export function usePushRegistration(enabled: boolean): { status: 'idle'|'granted'|'denied'|'unavailable' };
```
No-op with status `unavailable` when `Constants.expoConfig?.extra?.eas?.projectId` is missing or
running in Expo Go (remote push unsupported there — degrade gracefully, never throw).

`app/src/offline/persist.ts` (offline-persist):
```ts
export const queryPersistOptions: Omit<PersistQueryClientOptions, 'queryClient'>; // async-storage persister, whitelist below
```
Persist whitelist (by query key prefix): `parcels`, `farms`, `alerts`, `indices`, `weather`,
`agro`, `advisories`, `meta`, `me`. maxAge 24h. Never persist media tokens or auth.

Route strings (cross-agent, referenced by literal — do NOT import peer files):
`/forgot-password` · `/legal/privacy` · `/legal/terms` · `/security` (auth-flow) ·
`/scouting` (capture-observe) · `/weather` (existing hidden tab, now linked).

## Backend API additions (backend-core; appended to docs/API.md)

- `POST /api/v1/devices` `{ platform: "ios"|"android"|"web", token: string }` → 204. Upsert by
  token; row = org_id, user_id, platform, token, last_seen_at.
- `DELETE /api/v1/devices/{token}` → 204.
- `POST /api/v1/auth/password-reset/request` `{ email }` → **always 204** (no enumeration).
  Generates token (argon2-hashed at rest, 30 min expiry) and logs the reset link at info level
  (no SMTP in stack — email delivery is a documented TODO; do NOT add deps).
- `POST /api/v1/auth/password-reset/confirm` `{ token, new_password }` → 204 | 400 `invalid_token`.
- Push send: after the detect job inserts alerts, send **one Expo push per (parcel, kind) per run**
  — aggregated title like the app's grouped copy ("Uliveto Vecchio: calo di vigore su 12 piante"),
  to every device of the org. Endpoint `https://exp.host/--/api/v2/push/send` via reqwest,
  best-effort (log failures, never fail the job), disabled when `ARVO_PUSH_DISABLED=1`.
  Weather-advisory push = code TODO comment + API.md note only.

## Copy spec (copy-i18n; wave-2 agents consume these namespaces)

New/reworked namespaces (agent drafts full copy per tone rules; keys below are REQUIRED):
- `status.*`: `chip_ok` "Tutto bene" · `chip_watch` "Da tenere d'occhio" · `chip_attention`
  "Da controllare" · `headline_ok|watch|attention` · `partial` "Stima parziale" ·
  `trend_up` "In miglioramento" · `trend_flat` "Stabile" · `trend_down` "In peggioramento".
- `alerts_group.*`: `title_vigor_one/other` ("Calo di vigore su {{count}} piante — {{parcel}}"),
  `body_vigor` (plain explanation + what to do), generic `title_generic_one/other`,
  `confirm_all` · `snooze_all` · `dismiss_all` · `show_detail` "Dettagli tecnici" ·
  `checked` "Verificato".
- `weather_human.*`: `et0` "Acqua richiesta dalle piante (ET₀)" · `balance` "Bilancio idrico" ·
  `gdd` "Caldo accumulato (GDD)" · `heatwave_title` "Ondata di caldo da {{from}} a {{to}}" ·
  `heatwave_body` (peak temp + advice) · `frost_title` · singles for one-day events.
- `onboarding.*`: welcome value props (2 slides), `find_farm_title/body`,
  `first_value_title` "Stiamo scaricando le foto satellitari dei tuoi campi" +
  `first_value_body` "Ci vogliono un paio di minuti. Ti avvisiamo noi." · `add_first_field`.
- `prime.*`: `{location|camera|photos|notifications}_{title|body|cta|later}` — honest, specific
  Italian ("Per collegare il rilievo al punto esatto del campo…").
- `toast.*`: `saved` · `saved_offline` "Salvato. Si sincronizzerà da solo." · `synced` ·
  `error_retry`.
- `stats.*`: `mean` "Valore medio" · `p10` "Zone più deboli (10%)" · `p90` "Zone migliori (10%)".
- `auth.*` additions: `forgot` "Password dimenticata?" · `reset_*` (request + confirm screens) ·
  `biometric_*` (optional Face ID lock) · `legal_intro` + links labels.
- `settings.*` additions: `notifications` section (enable, severe-only, daily digest, quiet hours
  label), `security`, `help`, `legal`, `coming_soon_quaderno` "In arrivo: Quaderno di Campagna".
- `scouting.*` additions: sync-state lines recast as reassurance ("Tutto salvato sul telefono"),
  `open_list` "I tuoi rilievi".
- `map.*` additions: `search_fields` "Cerca campi" · `basemap_sat` "Satellite" · `basemap_map`
  "Mappa" · `offline_tiles` "Mappa non disponibile offline" · `zoom_in/out`.
- `parcel.*` rework: wizard step labels (`step_boundary` "Confini" · `step_info` "Informazioni"),
  `optional_details` "Aggiungi dettagli (facoltativo)", humanized errors
  (`photo_too_large`, `save_failed_retry`), `auto_farm_name` "Azienda di {{name}}".
- `common.*`: `updated_at` "Aggiornato alle {{time}}" · `offline` · `retry` · `close` · `back`.
- Terminology sweep across EXISTING keys: user-facing "particella" → **"campo"** everywhere EXCEPT
  cadastre-picker context (`parcel.cadastre_*` keeps "particella catastale" — legally correct);
  fix byte-identical EN/IT leftovers (`parcel.stat_p10/p90`, `dashboard.ndvi`, `fields.hectares`).

## Non-goals this run

- **Quaderno di Campagna: NOT built.** It is the next monetization feature — documented in
  `docs/BUSINESS.md` roadmap only. Do not scaffold screens or endpoints for it.
- No web portal restyling; no Android-specific work; no Sign in with Apple (needs dev-build
  entitlements — documented as pre-App-Store task); no email delivery infra.
