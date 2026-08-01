// OWNER: copy-i18n — locale persistence + device detection. Others add keys via i18n/pending/*.json.
import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { Platform } from 'react-native';

import { getLang } from '../auth/storage';
import en from './en.json';
import it from './it.json';

i18n.use(initReactI18next).init({
  resources: { it: { translation: it }, en: { translation: en } },
  lng: 'it',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

// Boot resolution: a saved choice wins; otherwise honor an English device (native) or
// browser (web). Anything that isn't English falls back to Italian (Italian-first product).
function detectLang(): 'it' | 'en' {
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en')) {
      return 'en';
    }
    return 'it';
  }
  try {
    return getLocales()[0]?.languageCode === 'en' ? 'en' : 'it';
  } catch {
    // expo-localization unavailable (e.g. bare test env) — keep the Italian default.
    return 'it';
  }
}

void getLang()
  .then((saved) => {
    const lang = saved ?? detectLang();
    if (lang !== i18n.language) void i18n.changeLanguage(lang);
  })
  .catch(() => {
    // storage unavailable (e.g. static web prerender) — keep the default locale.
  });

export default i18n;
