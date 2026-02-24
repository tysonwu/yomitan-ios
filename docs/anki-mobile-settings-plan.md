# AnkiMobile Settings Plan

Plan for modifying the Anki settings section to target AnkiMobile (iOS) via `anki://` URL scheme instead of AnkiConnect. Reference: [AnkiMobile URL Schemes](https://docs.ankimobile.net/url-schemes.html).

---

## Summary of Changes

| Setting                        | Action       | Anki Schema Mapping                       |
| ------------------------------ | ------------ | ----------------------------------------- |
| AnkiConnect server address     | **Remove**   | N/A – no AnkiConnect on mobile            |
| Card tags                      | **Keep**     | `tags=<space-separated>`                  |
| API key                        | **Remove**   | N/A – no AnkiConnect API                  |
| Check for card duplicates      | **Simplify** | `dupes=1` (allow) or omit (prevent)       |
| Screenshot format              | **Remove**   | N/A – no screenshot via URL               |
| Idle download timeout          | **Remove**   | N/A – no audio download                   |
| Suspend new cards              | **Remove**   | N/A – not in anki schema                  |
| Note viewer window             | **Modify**   | `x-success=<url>`                         |
| Show card tags and flags       | **Remove**   | N/A – cannot query existing cards         |
| Target tags                    | **Remove**   | (child of above)                          |
| Force Anki sync on adding card | **Keep**     | `anki://x-callback-url/sync`              |
| Configure Anki flashcards      | **Keep**     | Card format → `type`, `deck`, `fld<Name>` |
| Customize handlebars templates | **Keep**     | Field templates for rendering             |
| Generate notes                 | **Remove**   | Clumsy with URL scheme                    |

---

## Detailed Changes

### Remove

1. **AnkiConnect server address** (`anki.server`)

   - No AnkiConnect on iOS; always use URL scheme.

2. **API key** (`anki.apiKey`)

   - AnkiConnect-only.

3. **Screenshot format** (`anki.screenshot.format`, `anki.screenshot.quality`)

   - Screenshots not supported via URL scheme.

4. **Idle download timeout** (`anki.downloadTimeout`)

   - No audio download in AnkiMobile flow.

5. **Suspend new cards** (`anki.suspendNewCards`)

   - Not supported in `anki://x-callback-url/addnote`.

6. **Show card tags and flags** (`anki.displayTagsAndFlags`)

   - Cannot query existing cards via AnkiMobile URL scheme.

7. **Target tags** (`anki.targetTags`)

   - Only used with displayTagsAndFlags; remove with it.

8. **Generate notes** (modal + `AnkiDeckGeneratorController`)
   - Batch generation via AnkiConnect; not practical with URL scheme.
   - Remove: settings entry, modal, controller wiring.

### Simplify

9. **Check for card duplicates**
   - Current: checkbox + "Check across all models" + "Duplicate scope" + "When duplicate detected" (prevent/overwrite/new).
   - New: single option **"When a duplicate is detected"**:
     - `Prevent adding` (default) → omit `dupes=1`
     - `Allow adding` → include `dupes=1`
   - Remove: `checkForDuplicates`, `duplicateScopeCheckAllModels`, `duplicateScope`, `duplicateBehavior` (overwrite).
   - New schema: `allowDuplicateAdd: boolean` (or keep `duplicateBehavior` with only `prevent` | `new`).

### Modify

10. **Note viewer window** (`anki.noteGuiMode`)
    - Current: "Card browser" | "Note editor" (AnkiConnect).
    - New: **"Redirect to Yomitan after adding"** (toggle).
    - When enabled: pass `x-success=<orion-or-yomitan-url-scheme>` in addnote URL.
    - Requires: Orion/Yomitan URL scheme for return.
    - New schema: `redirectAfterAdd: boolean` (or repurpose `noteGuiMode`).

### Keep

11. **Card tags** (`anki.tags`) – maps to `tags=` in URL.

12. **Force Anki sync on adding card** (`anki.forceSync`)

    - After add: open `anki://x-callback-url/sync` when enabled.
    - Implementation: replace AnkiConnect `forceSync` call with URL navigation.

13. **Configure Anki flashcards** – card formats (deck, model, fields) map to URL params.

14. **Customize handlebars templates** – used to render field content for URL.

---

## Additional Considerations

### Enable Anki integration

- **Connection status**: AnkiConnect status check not possible. Options:
  - Remove status, or
  - Show "Enabled" / "Not enabled" only.

### Info section

- Update text: replace AnkiConnect setup with AnkiMobile + URL scheme.

### macOS notice

- Remove `data-show-for-os="mac"` AnkiConnect notice (or replace with AnkiMobile note if needed).

### Schema / options-util

- Add migration in `options-util.js` for removed/renamed fields.
- Update `options-schema.json` and `settings.d.ts` for new structure.
- Ensure import of desktop backups still works (removed fields get defaults/dropped).

---

## Files to Modify

| File                                       | Changes                                          |
| ------------------------------------------ | ------------------------------------------------ |
| `ext/settings.html`                        | Remove/modify/simplify Anki settings UI          |
| `ext/templates-modals.html`                | Remove Generate notes modal (or hide)            |
| `ext/js/pages/settings/anki-controller.js` | Update for new options, remove AnkiConnect logic |
| `ext/js/pages/settings/settings-main.js`   | Remove `AnkiDeckGeneratorController` wiring      |
| `ext/js/display/display-anki.js`           | Use URL scheme instead of AnkiConnect            |
| `ext/js/comm/anki-connect.js`              | Replace with `anki-url-scheme.js` or equivalent  |
| `ext/js/background/backend.js`             | Update `forceSync` for URL scheme                |
| `ext/data/schemas/options-schema.json`     | Update anki schema                               |
| `types/ext/settings.d.ts`                  | Update `AnkiOptions`                             |
| `ext/js/data/options-util.js`              | Migration for removed fields                     |

---

## Implementation Order

1. Create `anki-url-scheme.js` (build addnote URL, open sync URL).
2. Update `AnkiOptions` type and options schema.
3. Update settings HTML (remove, simplify, modify).
4. Update `anki-controller.js` for new options.
5. Update display/backend to use URL scheme instead of AnkiConnect.
6. Remove Generate notes (modal, controller, settings entry).
7. Add options migration for backward compatibility.
8. Update Info/help text for AnkiMobile.
