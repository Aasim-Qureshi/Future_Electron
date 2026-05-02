const i18nextModule = require('i18next');
const i18n = i18nextModule?.default ?? i18nextModule;
const { initReactI18next } = require('react-i18next');
const en = require('./translations/en.json');
const ar = require('./translations/ar.json');
const {
    detectInitialLanguage,
    persistLanguage,
    syncUrlLanguage,
    updateDocumentLanguage
} = require('./utils');

const initialLanguage = detectInitialLanguage();

updateDocumentLanguage(initialLanguage);
syncUrlLanguage(initialLanguage);

i18n.use(initReactI18next).init({
    resources: {
        en: { translation: en },
        ar: { translation: ar }
    },
    lng: initialLanguage,
    fallbackLng: 'en',
    supportedLngs: ['en', 'ar'],
    interpolation: {
        escapeValue: false
    },
    returnNull: false,
    returnEmptyString: false,
    saveMissing: true,
    missingKeyHandler: (lngs, ns, key) => {
        console.warn(`[i18n] Missing translation key: ${key}`);
    }
});

i18n.on('languageChanged', (lng) => {
    updateDocumentLanguage(lng);
    persistLanguage(lng);
    syncUrlLanguage(lng);
    console.info(`[i18n] Language switched to ${lng}`);
});

module.exports = i18n;
