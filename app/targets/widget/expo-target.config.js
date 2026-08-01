/**
 * ArvoWidget — Home Screen widget target (WidgetKit).
 *
 * Consumed by the `@bacons/apple-targets` config plugin during `expo prebuild`:
 * every directory under `app/targets/` that contains an `expo-target.config.js`
 * becomes a native Xcode target, and the Swift files next to it are compiled
 * into that target.
 *
 * NOTE: the plugin is NOT yet listed in app.json — this directory is inert
 * until the snippets in docs/IOS-WIDGET.md are applied. Widgets can never run
 * in Expo Go; a dev build (prebuild or EAS) is required.
 *
 * @type {import('@bacons/apple-targets').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'widget',
  name: 'ArvoWidget',
  deploymentTarget: '17.0',
  // Terra palette (docs/DESIGN.md §2) — generated into the target's asset
  // catalog. index.swift additionally keeps its own hex constants so the
  // Swift file is reviewable in isolation.
  colors: {
    $accent: '#234B34', // forest — primary actions
    $widgetBackground: { light: '#F2F1EC', dark: '#1B1E1A' }, // paper / dark paper
  },
  // Shared storage with the host app: the app writes the snapshot JSON to
  // this app group, the widget only reads it. The SAME group must be listed
  // under ios.entitlements in app.json (see docs/IOS-WIDGET.md).
  entitlements: {
    'com.apple.security.application-groups': ['group.com.arvo.app'],
  },
});
