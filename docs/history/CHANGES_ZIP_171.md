# Zip 171 — Settings tabs, sub-categories in Inventory
- Settings: "Payment methods I accept" and "Receipt keyboard shortcuts" are now tabs (💳 Payment Methods, ⌨️ Shortcuts, right after Receipt Settings) in every app instead of loose cards above the tabs. Restricted admins only see them if allowed (they are not in an admin's allowed-section list).
- Hotel: the Sub-categories manager moved out of Settings to the Inventory category toolbar (🗂️ Sub-categories, next to "Categories & assign" and "Import"). Same manager, same data.
- Bluetooth printer: the app never asks for a password; any PIN prompt is the phone/PC's own Bluetooth pairing (usually 0000 or 1234).
- Test: tests/zip171-settings-tabs.test.mjs. Stamp zip-171. No migration; workflows and native/ unchanged.
