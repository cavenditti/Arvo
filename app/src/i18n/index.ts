// OWNER: fe-shell — locale persistence + device detection. Others only add keys to it.json/en.json.
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

// Boot resolution: a saved choice wins; otherwise honor an English browser on web.
// Italian stays the default everywhere else (Italian-first product).
function detectLang(): 'it' | 'en' {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
    return navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'it';
  }
  return 'it';
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
