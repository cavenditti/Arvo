# TestFlight releases

This file is the persistent handoff for maintainers and future Codex sessions. The Apple
and Expo setup below was completed successfully on 2 August 2026. It contains identifiers
and operational instructions only—never add passwords, two-factor codes, access tokens,
or private keys.

## Release command

From `app/`, run:

```bash
npm run testflight
```

The command runs lint and TypeScript checks, verifies the active Expo login, then runs a
non-interactive EAS production build with automatic submission. Additional EAS build flags
can be passed after `--`, for example:

```bash
npm run testflight -- --message "Fix parcel creation"
```

Do not pass `--what-to-test` on the current Expo plan: Expo rejected that option because
TestFlight changelog automation requires an Enterprise plan. Add testing notes manually in
App Store Connect if needed.

## Stable project configuration

- Expo project: `@cavenditti/arvo`
- EAS project ID: `32b2ff14-cf07-4a95-990c-bbe6315e1ce8`
- EAS build and submit profile: `production`
- iOS bundle identifier: `farm.arvo.app`
- Apple team ID: `PN9822BHR7`
- App Store Connect provider ID: `129251952`
- App Store Connect app ID (`ascAppId`): `6797212459`
- TestFlight internal group: `Team (Expo)`
- Version source: remote; `autoIncrement` advances the iOS build number for every build
- Signing: distribution certificate, provisioning profile, push key, and App Store Connect
  API key are managed remotely by EAS
- The current distribution certificate expires on 2 August 2027; let EAS renew signing
  interactively when it eventually reports that renewal is required
- The EAS-managed App Store Connect API key has the `APP_MANAGER` role
- Export compliance: the app declares that it does not use non-exempt encryption

The EAS `production` environment must define `EXPO_PUBLIC_API_URL`. Inspect the project
environment before a release if the backend has moved:

```bash
eas env:list --environment production
```

Update the value through EAS rather than treating an ignored local `.env` file as the
production source of truth.

Change `expo.version` in `app.json` when a new user-facing version number is wanted. Do not
manually manage `ios.buildNumber`: EAS owns it remotely and increments it on each production
build.

## After triggering a release

The terminal waits for the build and submission by default, and prints links to both EAS
records. This command shows the latest iOS builds later:

```bash
eas build:list --platform ios --limit 5
```

Use the submission link printed by `npm run testflight`, or open the Expo project dashboard,
to inspect submission history.

Apple usually needs additional processing time after EAS reports a successful submission.
Open the app's TestFlight page at:

https://appstoreconnect.apple.com/apps/6797212459/testflight/ios

The first successful release was version `0.1.0`, build `1`:

- EAS build: https://expo.dev/accounts/cavenditti/projects/arvo/builds/164c19de-d6e6-4601-976e-6138d93205e0
- EAS submission: https://expo.dev/accounts/cavenditti/projects/arvo/submissions/31e85816-19da-4468-bcf1-821b649c0bbf

## Known release follow-ups

- The App Store Connect record was created as `Arvo (3ddbc7)` because the name `Arvo` was
  unavailable. Choose a unique public App Store name, such as `Arvo Farm`, before release.
- The production API was initially configured as a private plain-HTTP endpoint. TestFlight
  devices require access to its private network, and iOS may reject cleartext traffic. Move
  the backend to HTTPS—preferably `api.arvo.farm`—before relying on remote field testing or
  submitting the app for public review.
- If EAS authentication expires, run `eas login`. EAS should continue using its stored Apple
  signing assets and App Store Connect API key; a fresh Apple password or two-factor code is
  not normally needed for each release.
