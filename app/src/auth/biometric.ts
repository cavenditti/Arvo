// OWNER: auth-flow — Face ID / Touch ID availability + the boot-time lock decision.
// Web is always bypassed; every check fails soft so a broken sensor can never
// brick the app into an unopenable state.
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { getBiometricPref } from './storage';

export type BiometricAvailability = 'available' | 'not_enrolled' | 'unavailable';

/** What the device can do right now: hardware present and biometrics enrolled. */
export async function biometricAvailability(): Promise<BiometricAvailability> {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    if (!(await LocalAuthentication.hasHardwareAsync())) return 'unavailable';
    return (await LocalAuthentication.isEnrolledAsync()) ? 'available' : 'not_enrolled';
  } catch {
    return 'unavailable';
  }
}

/**
 * True only when the saved preference asks for the lock AND the device can run it.
 * If the user disabled Face ID at the OS level after opting in, we let them through
 * rather than lock them out of their own data.
 */
export async function biometricLockRequired(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    if (!(await getBiometricPref())) return false;
    return (await biometricAvailability()) === 'available';
  } catch {
    return false;
  }
}
