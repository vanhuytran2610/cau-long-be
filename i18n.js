const i18next = require("i18next");
const Backend = require("i18next-fs-backend");
const i18nextMiddleware = require("i18next-http-middleware");
const path = require("path");

i18next
  .use(Backend)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    fallbackLng: "vi",
    preload: ["vi", "en"],
    backend: {
      loadPath: path.join(__dirname, "locales", "{{lng}}", "translation.json"),
    },
    detection: {
      order: ["header"],
      caches: false,
    },
    interpolation: { escapeValue: false },
  });

module.exports = i18next;
