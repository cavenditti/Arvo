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
- `npx tsc --noEmit` — typecheck
