# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# TestFlight release memory

Read `TESTFLIGHT.md` before changing Apple signing, EAS Build, or EAS Submit configuration.

When the user asks to publish a new TestFlight build, run `npm run testflight` from this
directory. The production profile is already linked to the existing Apple app and uses
EAS-managed signing credentials. Do not recreate signing assets unless EAS reports that
they are invalid or missing. Never save or print Apple passwords, two-factor codes,
Expo access tokens, or App Store Connect private keys.
