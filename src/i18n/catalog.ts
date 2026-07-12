/**
 * i18n каталог (Wave 0.3). ru — по умолчанию, en — переключаемый. Строки
 * выносятся сюда по мере касания компонентов (не мигрируем всё разом).
 */

export type Lang = "ru" | "en";

export interface Dict {
  common: {
    cancel: string;
    save: string;
    delete: string;
    close: string;
    search: string;
    settings: string;
    newChat: string;
  };
  composer: {
    placeholder: string;
    send: string;
    stop: string;
    attach: string;
  };
  settings: {
    title: string;
    appearance: string;
    theme: string;
    language: string;
    exportConfig: string;
    importConfig: string;
    reset: string;
  };
}

const ru: Dict = {
  common: {
    cancel: "Отмена",
    save: "Сохранить",
    delete: "Удалить",
    close: "Закрыть",
    search: "Поиск",
    settings: "Настройки",
    newChat: "Новый диалог",
  },
  composer: {
    placeholder: "Напишите сообщение…",
    send: "Отправить",
    stop: "Остановить",
    attach: "Прикрепить контекст",
  },
  settings: {
    title: "Настройки",
    appearance: "Оформление",
    theme: "Тема",
    language: "Язык",
    exportConfig: "Экспорт конфига",
    importConfig: "Импорт конфига",
    reset: "Сбросить",
  },
};

const en: Dict = {
  common: {
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    close: "Close",
    search: "Search",
    settings: "Settings",
    newChat: "New chat",
  },
  composer: {
    placeholder: "Type a message…",
    send: "Send",
    stop: "Stop",
    attach: "Attach context",
  },
  settings: {
    title: "Settings",
    appearance: "Appearance",
    theme: "Theme",
    language: "Language",
    exportConfig: "Export config",
    importConfig: "Import config",
    reset: "Reset",
  },
};

export const CATALOG: Record<Lang, Dict> = { ru, en };
export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: "ru", label: "Русский" },
  { id: "en", label: "English" },
];
