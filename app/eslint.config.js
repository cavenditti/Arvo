// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*'],
  },
  {
    rules: {
      // React-compiler strictness, kept visible but non-blocking: legitimate
      // external-system syncs (GPS auto-pick) and Date.now()-based "NEW <24h" chips
      // trip these; restructuring them is tracked cleanup, not a release gate.
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
