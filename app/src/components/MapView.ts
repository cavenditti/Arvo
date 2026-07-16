// SPINE (read-only) — TS resolution shim. Metro picks MapView.web.tsx / MapView.native.tsx per
// platform; tsc resolves this file. Both implementations must keep identical props (./types.ts).
export { default } from './MapView.native';
