# iOS Home Screen widget — "I tuoi campi"

Status of this scaffold (UX-revamp run, 2026-08-01):

- `app/targets/widget/` contains a complete, minimal WidgetKit extension
  (`expo-target.config.js`, `index.swift`, `PrivacyInfo.xcprivacy`) following the
  [`@bacons/apple-targets`](https://github.com/EvanBacon/expo-apple-targets) convention.
- The plugin is **not yet installed or registered** — `app.json` and `package.json` were
  out of scope for this run, so the target directory is inert until §2 below is applied.
- The **app-side write bridge is NOT wired** in this run. The widget reads a JSON snapshot
  from the shared app group; §5 documents two options for writing it, with a ready-to-paste
  local-module skeleton. Until then the widget shows its honest empty state
  ("Apri Arvo per iniziare").
- Widgets **cannot run in Expo Go**. You need a dev build (`expo prebuild` + `expo run:ios`,
  or an EAS development build).
- The Swift in this repo has been reviewed but **never compiled** (no Xcode target exists
  until prebuild runs). Expect at most trivial fix-ups on first build, not design changes.

## 1. Data contract

The app writes; the widget only reads.

- Store: `UserDefaults(suiteName: "group.farm.arvo.app")`
- Key: `widget.snapshot`
- Value: JSON **string**:

```json
{
  "updatedAt": "2026-08-01T12:30:00.000Z",
  "fields": [
    { "name": "Vigneto Nord", "score": 48, "level": "attention" },
    { "name": "Uliveto Vecchio", "score": 71, "level": "watch" },
    { "name": "Orto 3", "score": 86, "level": "ok" }
  ]
}
```

- `score` — the Arvo score, 0–100 (`arvoScoreDetail(latest).score` from
  `@/features/insights/format`).
- `level` — the canonical `StatusLevel` from `@/features/insights/status`
  (`deriveFieldStatus(...).level`): `'ok' | 'watch' | 'attention'`. This matches the widget
  contract **1:1** — no mapping needed (the `'healthy'` remap exists only for `StatusChip`).
- Ordering is the app's concern; the widget renders the first 3 fields as given
  (2 on the small family).

Decoding on the Swift side is defensive: unknown `level` falls back to `watch`, a missing
`score` renders as "–", malformed JSON or an absent key falls back to the empty state.
Colors are the Terra palette (`docs/DESIGN.md` §2): leaf `#3F7D45` (ok), straw `#9A6A1E`
(watch), clay `#A5432B` (attention), on paper `#F2F1EC` (dark mode: ink `#1B1E1A` paper
with inverted text). Typography: system serif design for names/headings, monospaced digits
for score and time — the closest system stand-ins for Fraunces / IBM Plex Mono (custom
fonts in a widget target are a follow-up, see §7).

## 2. Install & register the plugin

```sh
cd app
npx expo install @bacons/apple-targets
```

Then apply these two `app.json` edits (owned by shell-nav / orchestrator — verbatim
snippets, merge into the existing objects):

**(a) Plugin entry** — append to the existing `expo.plugins` array (replace
`XXXXXXXXXX` with the Apple Team ID; it is required for signing the extra target):

```json
[
  "@bacons/apple-targets",
  { "appleTeamId": "XXXXXXXXXX" }
]
```

**(b) App-side app group** — the app must join the same app group the widget reads.
Add to the existing `expo.ios` object:

```json
"entitlements": {
  "com.apple.security.application-groups": ["group.farm.arvo.app"]
}
```

Notes:

- The widget target's own entitlements come from
  `app/targets/widget/expo-target.config.js` — already committed, nothing to add there.
- Newer Expo SDKs also accept `"appleTeamId"` directly under `expo.ios`; the plugin reads
  either. Pick one place.
- The widget's bundle id is derived: `farm.arvo.app.ArvoWidget`.

## 3. Prebuild & run locally

```sh
cd app
npx expo prebuild -p ios --clean
npx expo run:ios        # builds the app + embedded widget, needs Xcode installed
```

`prebuild` generates `app/ios/` with an `ArvoWidget` target wired from
`app/targets/widget/`. The generated `ios/` directory stays gitignored (CNG); the
committed source of truth is `app/targets/`.

After the app installs: long-press the Home Screen → **+** → search "Arvo" → add
"I tuoi campi" (small or medium). Until the bridge in §5 is wired it shows the
placeholder state — that is expected.

## 4. EAS build notes

- Use a **development** profile from `app/eas.json` (widgets never work in Expo Go):

  ```sh
  cd app
  eas build -p ios --profile development
  ```

- EAS CNG runs `prebuild` server-side; `app/targets/` is committed, so nothing extra to
  upload.
- Credentials: recent `eas-cli` detects the extra target and provisions
  `farm.arvo.app.ArvoWidget` alongside `farm.arvo.app`, including the app-group capability
  (it reads both entitlement sets). When prompted about a second target, accept. If you
  manage credentials manually instead, both App IDs need the App Groups capability with
  `group.farm.arvo.app` enabled in the Apple Developer portal.
- First store build: verify `PrivacyInfo.xcprivacy` is included as a resource of the
  ArvoWidget target (the plugin links files in the target directory; double-check
  membership in Xcode once, see §6).

## 5. App-side write path (NOT wired this run)

Two options. Option A is recommended and its skeleton is complete below — it was **not**
added under `app/src` or `app/modules` in this run on purpose (package/app config were
frozen); paste it when the plugin lands.

### Option A — tiny local Expo module (recommended)

Generate the scaffold once, then replace its generated files with the skeletons below:

```sh
cd app
npx create-expo-module@latest --local widget-bridge
```

(The generator produces `modules/widget-bridge/` with a podspec — keep the podspec,
replace the rest. Local modules are autolinked; no `package.json` change.)

`modules/widget-bridge/expo-module.config.json`:

```json
{
  "platforms": ["apple"],
  "apple": { "modules": ["WidgetBridgeModule"] }
}
```

`modules/widget-bridge/ios/WidgetBridgeModule.swift` (~20 lines):

```swift
import ExpoModulesCore
import WidgetKit

public class WidgetBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WidgetBridge")

    // Stores the snapshot JSON string in the shared app group and asks
    // WidgetKit to re-render. Fire-and-forget from JS.
    Function("setSnapshot") { (json: String) in
      guard let defaults = UserDefaults(suiteName: "group.farm.arvo.app") else { return }
      defaults.set(json, forKey: "widget.snapshot")
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
```

`modules/widget-bridge/index.ts` (~15 lines):

```ts
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type WidgetSnapshot = {
  updatedAt: string; // ISO timestamp
  fields: { name: string; score: number; level: 'ok' | 'watch' | 'attention' }[];
};

// Optional lookup: resolves to null in Expo Go / Android / web → silent no-op.
const native = Platform.OS === 'ios' ? requireOptionalNativeModule('WidgetBridge') : null;

export function setWidgetSnapshot(snapshot: WidgetSnapshot): void {
  native?.setSnapshot(JSON.stringify(snapshot));
}
```

Call site (dashboard, after parcels + latest indices resolve — sketch, adapt to the
dashboard's actual data hooks):

```ts
import { deriveFieldStatus } from '@/features/insights/status';
import { arvoScoreDetail } from '@/features/insights/format';
import { setWidgetSnapshot } from '../../modules/widget-bridge'; // no @/ alias: modules/ sits beside src/

const fields = parcels.slice(0, 3).map((p) => {
  const detail = arvoScoreDetail(latestByParcel[p.id]);
  const status = deriveFieldStatus({
    score: detail.score,
    trend: trendByParcel[p.id] ?? null,
    openAlertEvents: openEventsByParcel[p.id] ?? 0,
    coverage: detail.coverage,
  });
  return { name: p.name, score: detail.score ?? 0, level: status.level };
});
setWidgetSnapshot({ updatedAt: new Date().toISOString(), fields });
```

### Option B — community package

`expo-shared-group-preferences` (or similar) does the UserDefaults write without custom
Swift, but (a) it needs a `package.json` change, (b) it does not call
`WidgetCenter.reloadAllTimelines()`, so the widget only refreshes on its own lazy
30-minute policy. Only worth it if local modules are off the table.

## 6. Testing via Xcode

1. **Canvas previews (no data needed):** open `app/ios/Arvo.xcworkspace` after prebuild,
   select `app/targets/widget/index.swift` — two `#Preview` blocks render the medium
   widget (data + empty state timeline) and the small one. Toggle light/dark in the
   canvas to check both papers.
2. **Widget scheme:** pick the `ArvoWidget` scheme → a simulator → Run. Xcode installs
   the host app and attaches to the widget process; add the widget to the Home Screen if
   it is not there yet. `print` / `os_log` from the provider shows up in this scheme's
   console.
3. **Seeding data before the bridge exists:** paste this temporarily into the generated
   `AppDelegate` (or anywhere in the app target that runs at launch), run the **app**
   scheme once, then re-run the widget scheme. It is throwaway — `prebuild --clean`
   regenerates `ios/`.

   ```swift
   if let defaults = UserDefaults(suiteName: "group.farm.arvo.app") {
     defaults.set(
       #"{"updatedAt":"2026-08-01T12:30:00Z","fields":[{"name":"Vigneto Nord","score":48,"level":"attention"},{"name":"Uliveto Vecchio","score":71,"level":"watch"},{"name":"Orto 3","score":86,"level":"ok"}]}"#,
       forKey: "widget.snapshot")
   }
   ```

4. **Forcing a refresh:** widgets cache aggressively in the simulator. Remove and re-add
   the widget, or call `WidgetCenter.shared.reloadAllTimelines()` from the app, rather
   than waiting for the timeline policy.
5. Tapping the widget deep-links to `arvo://` (the app scheme from `app.json`).

## 7. Known gaps / follow-ups

- **Bridge not wired** (§5) — the deliberate gap of this run.
- Widget copy is hardcoded Italian ("I tuoi campi", "Apri Arvo per iniziare",
  "Aggiornato alle HH:mm"). WidgetKit cannot read the app's i18n JSON; EN parity means
  adding `it.lproj`/`en.lproj` `Localizable.strings` to the target directory and
  switching to `String(localized:)`.
- System serif/mono stand in for Fraunces / IBM Plex Mono. Bundling the real fonts in
  the target (plus `UIAppFonts` in the widget Info.plist) is a polish task.
- Time renders as fixed `HH:mm` (correct for the Italian primary audience); a locale-aware
  `Date.FormatStyle` is the cleanup when EN localization lands.
- `apple-targets` is pre-1.0: on upgrade, re-check the `expo-target.config.js` schema
  (`type: 'widget'`, `colors`, `entitlements` are stable today).
- If the app is ever backgrounded while writing large snapshots, consider trimming to the
  3 worst fields app-side (the widget truncates anyway).
