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
Secret Service keyring in the same graphical session that runs Kyrei. On a
minimal Arch installation, install one backend and then sign out and in again:

```bash
sudo pacman -S gnome-keyring
```

KDE users may enable KWallet instead. KeePassXC and oo7 also work when their
Secret Service integration is enabled. After signing back in, run `kyrei` as
your ordinary user and save the provider again. If the dialog still reports
that secure storage is unavailable, the key was not saved and has not been
written to disk in plain text.

## Debian/Ubuntu

```bash
sudo apt install ./Kyrei-<version>-amd64.deb
kyrei
```

## AppImage

An AppImage does not need an administrator account. Make it executable and
launch it from your ordinary account:

```bash
chmod +x Kyrei-<version>-x86_64.AppImage
./Kyrei-<version>-x86_64.AppImage
```

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
графической сессии, из которой запускается Kyrei, нужен разблокированный
keyring с Secret Service. В минимальной установке Arch установите один backend,
затем выйдите и войдите в систему снова:

```bash
sudo pacman -S gnome-keyring
```

Пользователи KDE могут включить KWallet вместо него. KeePassXC и oo7 тоже
работают при включённой интеграции Secret Service. После повторного входа
запустите `kyrei` от обычного пользователя и сохраните провайдера ещё раз. Если
диалог всё ещё сообщает о недоступности защищённого хранилища, ключ не был
сохранён и не записывался на диск открытым текстом.

## Debian/Ubuntu

```bash
sudo apt install ./Kyrei-<version>-amd64.deb
kyrei
```

## AppImage

AppImage не требует прав администратора. Сделайте файл исполняемым и запустите
его из обычной учётной записи:

```bash
chmod +x Kyrei-<version>-x86_64.AppImage
./Kyrei-<version>-x86_64.AppImage
```
