import type { MessageCatalog } from "../../types";

export const enCommon = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.clear": "Clear",
  "common.search": "Search",
  "common.settings": "Settings",
  "common.newChat": "New chat",
  "common.welcome": "Welcome, {name}",
  "common.items": {
    one: "{count} item",
    other: "{count} items",
  },
} as const satisfies MessageCatalog;
