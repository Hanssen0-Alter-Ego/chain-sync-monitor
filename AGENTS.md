# Localization

- The dashboard supports English, Simplified Chinese, Traditional Chinese, Japanese, French and German. Keep existing locales complete whenever you add or change user-visible text, including accessibility labels, units, tooltips, empty states and backend diagnostics shown in the dashboard.
- Simplified Chinese keys are also used by existing backend payloads. Keep payload keys stable when possible so Netlify frontends and older Docker backends remain compatible. Register new keys in the English dictionary in `frontend/src/i18n.ts` and in `frontend/src/locales.ts`, `frontend/src/fr.ts` and `frontend/src/de.ts`. Update localized dynamic diagnostic templates in `i18n.ts` as needed. Do not translate custom service labels or raw protocol identifiers.
- Locale detection follows browser preferences in Auto mode. Explicit choices persist when browser storage is available; do not require storage. Apply number, percentage and date formatting in the active locale.
- Run `npm test`. Update localization tests for new keys, dynamic diagnostics and any change to selector behavior. Keep the locale dictionaries in exact key parity.
