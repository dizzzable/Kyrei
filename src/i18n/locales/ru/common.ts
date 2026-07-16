import type { LocaleFor } from "../../types";
import type { enCommon } from "../en/common";

export const ruCommon = {
  "common.cancel": "Отмена",
  "common.dismiss": "Скрыть",
  "common.retry": "Повторить",
  "common.save": "Сохранить",
  "common.delete": "Удалить",
  "common.close": "Закрыть",
  "common.clear": "Очистить",
  "common.search": "Поиск",
  "common.settings": "Настройки",
  "common.newChat": "Новый диалог",
  "common.welcome": "Добро пожаловать, {name}",
  "common.items": {
    one: "{count} элемент",
    few: "{count} элемента",
    many: "{count} элементов",
    other: "{count} элемента",
  },
} as const satisfies LocaleFor<typeof enCommon>;
