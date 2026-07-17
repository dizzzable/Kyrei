# Linux and Arch: install with sudo, run Kyrei without it

Kyrei is a desktop Electron application. Its Chromium sandbox intentionally
stays enabled, so it cannot and must not run under `root`.

## Arch Linux

Use administrator rights only to install or update the downloaded package:

```bash
sudo pacman -U ./Kyrei-<version>-x64.pkg.tar.zst
```

Then open Kyrei from the application menu or run it as your normal desktop
user:

```bash
kyrei
```

Do **not** run `sudo kyrei`, do not start it from a root shell, and do not add
`--no-sandbox`. If that command is used accidentally, Kyrei now exits before
Electron starts and explains the correct command instead of showing Chromium's
root-process crash.

If unprivileged Linux user namespaces are unavailable, an AppImage may attempt
to add `--no-sandbox`. Kyrei rejects that unsafe fallback before Electron runs
and explains the fix. Use the DEB or Arch package instead, or enable user
namespaces according to your distribution's security policy. Do not bypass the
problem with `--no-sandbox`.

## Provider API keys on Linux and Arch

Kyrei never writes a provider key as plain text. Linux needs an unlocked
**Secret Service** keyring (`org.freedesktop.secrets`) in the **same graphical
session** that runs Kyrei. The package depends on `libsecret` (the client
library Electron uses). A keyring **daemon** is optional at install time but
**required** before provider keys can be saved.

Wayland and X11 are both supported. Failures on Wayland almost always mean the
session has no unlocked Secret Service — not that Wayland itself is blocked.

### Desktop environment matrix

| Environment | Session types | Recommended backend | Arch | Debian/Ubuntu |
| --- | --- | --- | --- | --- |
| GNOME | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| KDE Plasma | Wayland / X11 | KWallet | `kwallet` | `kwalletmanager` |
| Cinnamon | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| XFCE | X11 (Wayland experimental) | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| MATE | X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| Budgie | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| COSMIC | Wayland | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| elementary / Pantheon | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| LXQt | X11 / Wayland | gnome-keyring or KeePassXC | `gnome-keyring` | `gnome-keyring` |
| Hyprland | Wayland | gnome-keyring or KeePassXC | `gnome-keyring` | `gnome-keyring` |
| Sway | Wayland | gnome-keyring or KeePassXC | `gnome-keyring` | `gnome-keyring` |
| niri / river | Wayland | gnome-keyring or KeePassXC | `gnome-keyring` | `gnome-keyring` |

KeePassXC and oo7 also work when their **Secret Service** integration is enabled.

### Minimal Arch (any DE/WM)

```bash
sudo pacman -S gnome-keyring
```

KDE Plasma users may prefer:

```bash
sudo pacman -S kwallet
```

Then **sign out and sign back in** (a full graphical re-login, not only restarting
Kyrei). Run `kyrei` as your ordinary user and save the provider again.

The Arch package lists `gnome-keyring`, `kwallet`, and `keepassxc` as optional
dependencies so installers can surface them without forcing one desktop stack.

### Pure Wayland WMs (Hyprland, Sway, niri, river)

These compositors do not start a keyring for you:

1. Install `gnome-keyring` (or KeePassXC with Secret Service).
2. Ensure the keyring unlocks with your login (PAM / display-manager integration)
   or unlock it once after login.
3. Confirm the session bus has Secret Service:

   ```bash
   echo "$XDG_SESSION_TYPE"   # expect wayland
   busctl --user status org.freedesktop.secrets
   ```

4. Start Kyrei from that same session (`kyrei`, not `sudo kyrei`).

If the dialog still reports that secure storage is unavailable, the key was not
saved and has not been written to disk in plain text. Check the terminal or
journal for a `[kyrei] Linux protected credential storage is unavailable`
line; it includes session type, desktop family, and install hints.

## Debian/Ubuntu

```bash
sudo apt install ./Kyrei-<version>-amd64.deb
kyrei
```

The DEB hard-depends on `libsecret-1-0` and recommends `gnome-keyring` (plus
`libsecret-tools` for diagnostics). KDE users can install `kwalletmanager`
instead of or in addition to `gnome-keyring`.

## AppImage

An AppImage does not need an administrator account. Make it executable and
launch it from your ordinary account:

```bash
chmod +x Kyrei-<version>-x86_64.AppImage
./Kyrei-<version>-x86_64.AppImage
```

Secret Service requirements are the same as for the DEB/pacman packages: the
AppImage still talks to your session keyring via `libsecret`.

---

# Linux и Arch: `sudo` только для установки, Kyrei запускается без него

Kyrei — desktop-приложение Electron. Песочница Chromium намеренно остаётся
включённой, поэтому запуск от `root` не поддерживается и не нужен.

## Arch Linux

Права администратора нужны только для установки или обновления скачанного
пакета:

```bash
sudo pacman -U ./Kyrei-<version>-x64.pkg.tar.zst
```

После этого откройте Kyrei из меню приложений или запустите от обычного
пользователя:

```bash
kyrei
```

Не запускайте `sudo kyrei`, не открывайте его из root-shell и не добавляйте
`--no-sandbox`. При ошибочном root-запуске Kyrei теперь завершится до старта
Electron и покажет правильную команду вместо аварийного сообщения Chromium.

Если непривилегированные user namespaces недоступны в Linux, AppImage может
попытаться добавить `--no-sandbox`. Kyrei отклонит этот небезопасный fallback
до запуска Electron и покажет способ исправления. Используйте DEB- или
Arch-пакет либо включите user namespaces согласно политике безопасности
дистрибутива. Не обходите проблему через `--no-sandbox`.

## API-ключи провайдера в Linux и Arch

Kyrei никогда не записывает ключ провайдера открытым текстом. В Linux для
**той же графической сессии**, из которой запускается Kyrei, нужен
разблокированный **Secret Service** (`org.freedesktop.secrets`). Пакет зависит
от `libsecret` (клиентская библиотека Electron). Демон keyring **не**
является жёсткой зависимостью при установке, но **обязателен**, чтобы
сохранить API-ключи.

Wayland и X11 поддерживаются. Сбои на Wayland почти всегда означают, что в
сессии нет разблокированного Secret Service, а не запрет Wayland.

### Матрица окружений

| Окружение | Сессии | Backend | Arch | Debian/Ubuntu |
| --- | --- | --- | --- | --- |
| GNOME | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| KDE Plasma | Wayland / X11 | KWallet | `kwallet` | `kwalletmanager` |
| Cinnamon | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| XFCE | X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| MATE | X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| Budgie | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| COSMIC | Wayland | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| elementary / Pantheon | Wayland / X11 | gnome-keyring | `gnome-keyring` | `gnome-keyring` |
| LXQt | X11 / Wayland | gnome-keyring или KeePassXC | `gnome-keyring` | `gnome-keyring` |
| Hyprland | Wayland | gnome-keyring или KeePassXC | `gnome-keyring` | `gnome-keyring` |
| Sway | Wayland | gnome-keyring или KeePassXC | `gnome-keyring` | `gnome-keyring` |
| niri / river | Wayland | gnome-keyring или KeePassXC | `gnome-keyring` | `gnome-keyring` |

KeePassXC и oo7 тоже работают при включённой интеграции Secret Service.

### Минимальный Arch (любой DE/WM)

```bash
sudo pacman -S gnome-keyring
```

Для KDE Plasma можно:

```bash
sudo pacman -S kwallet
```

Затем **выйдите и войдите** в графическую сессию (полный re-login, не только
перезапуск Kyrei). Запустите `kyrei` от обычного пользователя и сохраните
провайдера снова.

Arch-пакет помечает `gnome-keyring`, `kwallet` и `keepassxc` как optional
dependencies, чтобы установщик мог их показать, не навязывая один стек
рабочего стола.

### Чистые Wayland WM (Hyprland, Sway, niri, river)

Эти композиторы сами keyring не поднимают:

1. Установите `gnome-keyring` (или KeePassXC с Secret Service).
2. Убедитесь, что keyring разблокируется при входе (PAM / display manager)
   или разблокируйте его после login.
3. Проверьте session bus:

   ```bash
   echo "$XDG_SESSION_TYPE"   # ожидается wayland
   busctl --user status org.freedesktop.secrets
   ```

4. Запустите Kyrei из этой же сессии (`kyrei`, не `sudo kyrei`).

Если диалог по-прежнему сообщает о недоступности защищённого хранилища, ключ
не был сохранён и не записывался на диск открытым текстом. В терминале или
journal ищите строку
`[kyrei] Linux protected credential storage is unavailable` — в ней есть тип
сессии, семейство DE/WM и подсказки по установке.

## Debian/Ubuntu

```bash
sudo apt install ./Kyrei-<version>-amd64.deb
kyrei
```

DEB жёстко зависит от `libsecret-1-0` и рекомендует `gnome-keyring` (и
`libsecret-tools` для диагностики). Пользователи KDE могут поставить
`kwalletmanager` вместо или вместе с `gnome-keyring`.

## AppImage

AppImage не требует прав администратора. Сделайте файл исполняемым и запустите
его из обычной учётной записи:

```bash
chmod +x Kyrei-<version>-x86_64.AppImage
./Kyrei-<version>-x86_64.AppImage
```

Требования Secret Service те же, что у DEB/pacman: AppImage обращается к
keyring сессии через `libsecret`.
