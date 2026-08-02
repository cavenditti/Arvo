# Arvo app

Expo (React Native + TypeScript) client for the Arvo platform — one codebase for iOS,
Android and the web portal. See the [repo root README](../README.md) for the full
quickstart (database, backend, seed) and [docs/DESIGN.md](../docs/DESIGN.md) for the
Terra design language this UI follows.

```bash
npm install
npx expo start        # press `w` for the web portal, or scan the QR in Expo Go
```

The API base URL defaults to `http://localhost:8787`. Testing on a phone, point it at
your machine: set `EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:8787` in `app/.env`.

- `npm run lint` — ESLint (expo config)
- `npm run typecheck` — TypeScript typecheck
- `npm run testflight` — validate, build the production iOS app, and submit it to TestFlight

The TestFlight command uses the existing remote Apple signing credentials and increments
the iOS build number automatically. See [TESTFLIGHT.md](./TESTFLIGHT.md) for the persistent
release configuration, status commands, and known production API caveat.
