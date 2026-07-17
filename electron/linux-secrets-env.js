/**
 * Linux/Arch Secret Service environment helpers for Electron safeStorage.
 * Pure Node module (no Electron imports) so packaging and unit tests can reuse it.
 *
 * Kyrei never accepts Electron's basic_text backend as protected storage. A working
 * org.freedesktop.secrets provider must be available in the same graphical session.
 */

/** @typedef {"gnome" | "kde" | "xfce" | "cinnamon" | "mate" | "budgie" | "cosmic" | "pantheon" | "lxqt" | "hyprland" | "sway" | "niri" | "river" | "unknown"} LinuxDesktopFamily */

/**
 * @typedef {object} LinuxSecretsEnvironment
 * @property {string} sessionType  XDG_SESSION_TYPE (wayland | x11 | …)
 * @property {string} currentDesktop  raw XDG_CURRENT_DESKTOP
 * @property {string} desktopSession  raw DESKTOP_SESSION / XDG_SESSION_DESKTOP
 * @property {LinuxDesktopFamily} family
 * @property {boolean} wayland
 * @property {string} archPackage
 * @property {string} debPackage
 * @property {string} reason
 */

const FAMILY_PACKAGES = Object.freeze({
  gnome: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "GNOME / GNOME-based Secret Service (libsecret)",
  },
  kde: {
    arch: "kwallet",
    deb: "kwalletmanager",
    reason: "KDE Plasma KWallet Secret Service",
  },
  xfce: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "XFCE commonly uses gnome-keyring as Secret Service",
  },
  cinnamon: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "Cinnamon uses gnome-keyring",
  },
  mate: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "MATE uses gnome-keyring",
  },
  budgie: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "Budgie uses gnome-keyring",
  },
  cosmic: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "COSMIC sessions typically need a Secret Service provider such as gnome-keyring",
  },
  pantheon: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "elementary/Pantheon uses gnome-keyring",
  },
  lxqt: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "LXQt has no built-in Secret Service; install gnome-keyring or KeePassXC",
  },
  hyprland: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "Hyprland does not start a keyring by default; install and unlock gnome-keyring (or KeePassXC)",
  },
  sway: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "Sway does not start a keyring by default; install and unlock gnome-keyring (or KeePassXC)",
  },
  niri: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "niri does not start a keyring by default; install and unlock gnome-keyring (or KeePassXC)",
  },
  river: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "river does not start a keyring by default; install and unlock gnome-keyring (or KeePassXC)",
  },
  unknown: {
    arch: "gnome-keyring",
    deb: "gnome-keyring",
    reason: "Generic Linux session: need any unlocked Secret Service (gnome-keyring, KWallet, KeePassXC, oo7)",
  },
});

/**
 * Arch pacman optdepends lines for electron-builder fpm
 * (`--pacman-optional-depends=pkg: description`).
 */
export const LINUX_PACMAN_SECRET_OPTDEPENDS = Object.freeze([
  "kwallet: KDE Plasma KWallet Secret Service (alternative to gnome-keyring)",
  "keepassxc: alternative Secret Service provider when desktop keyring is unavailable",
  "xorg-xwayland: XWayland fallback for Electron on pure Wayland if native Ozone fails",
]);

/** Installed automatically by the native Linux packages. */
export const LINUX_PACMAN_SECRET_DEPENDS = Object.freeze(["libsecret", "gnome-keyring"]);
export const LINUX_DEB_SECRET_DEPENDS = Object.freeze(["libsecret-1-0", "gnome-keyring"]);

/**
 * Debian/Ubuntu Recommends for provider-key diagnostics.
 * libsecret-1-0 and gnome-keyring are hard Depends of the native package.
 */
export const LINUX_DEB_SECRET_RECOMMENDS = Object.freeze([
  "libsecret-tools",
]);

/**
 * Electron's legacy desktop-name heuristic misses Hyprland/Sway/niri and other
 * valid Secret Service sessions. Force the generic libsecret client unless the
 * operator explicitly selected another password store.
 */
export function configureLinuxSecretServiceBackend({ platform = process.platform, commandLine } = {}) {
  if (platform !== "linux" || !commandLine?.hasSwitch || !commandLine?.appendSwitch) return false;
  if (commandLine.hasSwitch("password-store")) return false;
  commandLine.appendSwitch("password-store", "gnome-libsecret");
  return true;
}

export function linuxProtectedStorageAvailable({ backend, encryptionAvailable }) {
  return encryptionAvailable === true && [
    "gnome_libsecret",
    "kwallet",
    "kwallet5",
    "kwallet6",
  ].includes(backend);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined} env
 * @returns {string}
 */
function readEnv(env, key) {
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {string} haystack
 * @returns {LinuxDesktopFamily}
 */
export function classifyLinuxDesktopFamily(haystack) {
  const value = String(haystack || "").toLowerCase();
  if (!value) return "unknown";
  // Order matters: match specific WMs/DEs before broad "gnome".
  if (/\bhyprland\b/.test(value)) return "hyprland";
  if (/\bsway\b/.test(value)) return "sway";
  if (/\bniri\b/.test(value)) return "niri";
  if (/\briver\b/.test(value)) return "river";
  if (/\b(kde|plasma|plasma5|plasma6)\b/.test(value)) return "kde";
  if (/\bcinnamon\b/.test(value)) return "cinnamon";
  if (/\bbudgie\b/.test(value)) return "budgie";
  if (/\bmate\b/.test(value)) return "mate";
  if (/\bxfce\b/.test(value)) return "xfce";
  if (/\b(cosmic|pop:cosmic)\b/.test(value)) return "cosmic";
  if (/\b(pantheon|elementary)\b/.test(value)) return "pantheon";
  if (/\blxqt\b/.test(value)) return "lxqt";
  if (/\b(gnome|ubuntu:gnome|unity)\b/.test(value)) return "gnome";
  return "unknown";
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined} env
 * @returns {LinuxSecretsEnvironment}
 */
export function describeLinuxSecretsEnvironment(env = process.env) {
  const sessionType = readEnv(env, "XDG_SESSION_TYPE").toLowerCase() || "unknown";
  const currentDesktop = readEnv(env, "XDG_CURRENT_DESKTOP");
  const desktopSession =
    readEnv(env, "XDG_SESSION_DESKTOP") ||
    readEnv(env, "DESKTOP_SESSION") ||
    readEnv(env, "GDMSESSION");
  const family = classifyLinuxDesktopFamily(`${currentDesktop};${desktopSession}`);
  const packages = FAMILY_PACKAGES[family] ?? FAMILY_PACKAGES.unknown;
  return {
    sessionType,
    currentDesktop: currentDesktop || "unknown",
    desktopSession: desktopSession || "unknown",
    family,
    wayland: sessionType === "wayland",
    archPackage: packages.arch,
    debPackage: packages.deb,
    reason: packages.reason,
  };
}

/**
 * Recommended install lines for the detected desktop (Arch + Debian).
 * Always includes KDE alternative and KeePassXC so mixed/minimal sessions are covered.
 *
 * @param {LinuxSecretsEnvironment} environment
 * @returns {string[]}
 */
export function linuxSecretsInstallCommands(environment) {
  const arch = environment?.archPackage || "gnome-keyring";
  const deb = environment?.debPackage || "gnome-keyring";
  const commands = [
    `Arch: sudo pacman -S ${arch}`,
    `Debian/Ubuntu: sudo apt install ${deb}`,
  ];
  if (arch !== "kwallet") {
    commands.push("Arch (KDE Plasma): sudo pacman -S kwallet");
    commands.push("Debian/Ubuntu (KDE Plasma): sudo apt install kwalletmanager");
  }
  commands.push("Alternative (any DE/WM): KeePassXC with Secret Service enabled");
  return commands;
}

/**
 * Human-readable diagnostic for logs when safeStorage cannot protect secrets.
 *
 * @param {{
 *   backend?: string | null,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined> | null,
 * }} [options]
 * @returns {string}
 */
export function formatLinuxSecretsUnavailableMessage(options = {}) {
  const environment = describeLinuxSecretsEnvironment(options.env ?? process.env);
  const backend = typeof options.backend === "string" && options.backend
    ? options.backend
    : "unavailable";
  const commands = linuxSecretsInstallCommands(environment).join("; ");
  return [
    "[kyrei] Linux protected credential storage is unavailable.",
    `backend=${backend}`,
    `session=${environment.sessionType}`,
    `desktop=${environment.currentDesktop}`,
    `family=${environment.family}`,
    `wayland=${environment.wayland ? "yes" : "no"}`,
    `hint=${environment.reason}`,
    `install: ${commands}`,
    "Sign out and back into the graphical session after installing a keyring, then run kyrei as your normal user (not sudo).",
  ].join(" ");
}

/**
 * fpm args that attach Secret Service optdepends to the Arch package.
 * @returns {string[]}
 */
export function linuxPacmanSecretServiceFpmArgs() {
  return LINUX_PACMAN_SECRET_OPTDEPENDS.map(
    (entry) => `--pacman-optional-depends=${entry}`,
  );
}
