// OWNER: fe-shell — locale persistence + device detection. Others only add keys to it.json/en.json.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import it from './it.json';

i18n.use(initReactI18next).init({
  resources: { it: { translation: it }, en: { translation: en } },
  lng: 'it',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
