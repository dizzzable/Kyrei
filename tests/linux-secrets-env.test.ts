import { describe, expect, it, vi } from "vitest";
import {
  LINUX_DEB_SECRET_DEPENDS,
  LINUX_DEB_SECRET_RECOMMENDS,
  LINUX_PACMAN_SECRET_DEPENDS,
  LINUX_PACMAN_SECRET_OPTDEPENDS,
  classifyLinuxDesktopFamily,
  configureLinuxSecretServiceBackend,
  describeLinuxSecretsEnvironment,
  formatLinuxSecretsUnavailableMessage,
  linuxProtectedStorageAvailable,
  linuxPacmanSecretServiceFpmArgs,
  linuxSecretsInstallCommands,
} from "../electron/linux-secrets-env.js";

describe("linux secrets environment", () => {
  it("classifies popular desktop environments and Wayland WMs", () => {
    expect(classifyLinuxDesktopFamily("GNOME")).toBe("gnome");
    expect(classifyLinuxDesktopFamily("ubuntu:GNOME")).toBe("gnome");
    expect(classifyLinuxDesktopFamily("KDE")).toBe("kde");
    expect(classifyLinuxDesktopFamily("X-Cinnamon")).toBe("cinnamon");
    expect(classifyLinuxDesktopFamily("XFCE")).toBe("xfce");
    expect(classifyLinuxDesktopFamily("MATE")).toBe("mate");
    expect(classifyLinuxDesktopFamily("Budgie:GNOME")).toBe("budgie");
    expect(classifyLinuxDesktopFamily("COSMIC")).toBe("cosmic");
    expect(classifyLinuxDesktopFamily("Pantheon")).toBe("pantheon");
    expect(classifyLinuxDesktopFamily("LXQt")).toBe("lxqt");
    expect(classifyLinuxDesktopFamily("Hyprland")).toBe("hyprland");
    expect(classifyLinuxDesktopFamily("sway")).toBe("sway");
    expect(classifyLinuxDesktopFamily("niri")).toBe("niri");
    expect(classifyLinuxDesktopFamily("river")).toBe("river");
    expect(classifyLinuxDesktopFamily("")).toBe("unknown");
  });

  it("prefers Plasma packages on KDE and gnome-keyring elsewhere", () => {
    const kde = describeLinuxSecretsEnvironment({
      XDG_SESSION_TYPE: "wayland",
      XDG_CURRENT_DESKTOP: "KDE",
    });
    expect(kde.family).toBe("kde");
    expect(kde.wayland).toBe(true);
    expect(kde.archPackage).toBe("kwallet");
    expect(kde.debPackage).toBe("kwalletmanager");

    const hypr = describeLinuxSecretsEnvironment({
      XDG_SESSION_TYPE: "wayland",
      XDG_CURRENT_DESKTOP: "Hyprland",
    });
    expect(hypr.family).toBe("hyprland");
    expect(hypr.archPackage).toBe("gnome-keyring");
    expect(linuxSecretsInstallCommands(hypr).some((line) => line.includes("gnome-keyring"))).toBe(true);
  });

  it("formats a support log line without leaking secrets", () => {
    const message = formatLinuxSecretsUnavailableMessage({
      backend: "basic_text",
      env: {
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: "sway",
      },
    });
    expect(message).toContain("backend=basic_text");
    expect(message).toContain("session=wayland");
    expect(message).toContain("family=sway");
    expect(message).toContain("gnome-keyring");
    expect(message).not.toMatch(/api[_-]?key|token|password/i);
  });

  it("exports packaging metadata for hard dependencies and alternatives", () => {
    expect(LINUX_PACMAN_SECRET_DEPENDS).toEqual(expect.arrayContaining(["libsecret", "gnome-keyring"]));
    expect(LINUX_PACMAN_SECRET_OPTDEPENDS.some((line) => line.startsWith("kwallet:"))).toBe(true);
    expect(LINUX_DEB_SECRET_DEPENDS).toEqual(expect.arrayContaining(["libsecret-1-0", "gnome-keyring"]));
    expect(LINUX_DEB_SECRET_RECOMMENDS).toContain("libsecret-tools");
    expect(LINUX_DEB_SECRET_RECOMMENDS).not.toContain("gnome-keyring");
    expect(linuxPacmanSecretServiceFpmArgs()).toEqual(
      LINUX_PACMAN_SECRET_OPTDEPENDS.map((entry) => `--pacman-optional-depends=${entry}`),
    );
  });

  it("forces the generic Secret Service backend without overriding an explicit choice", () => {
    const commandLine = {
      hasSwitch: vi.fn(() => false),
      appendSwitch: vi.fn(),
    };
    expect(configureLinuxSecretServiceBackend({ platform: "linux", commandLine })).toBe(true);
    expect(commandLine.appendSwitch).toHaveBeenCalledWith("password-store", "gnome-libsecret");

    commandLine.hasSwitch.mockReturnValue(true);
    expect(configureLinuxSecretServiceBackend({ platform: "linux", commandLine })).toBe(false);
    expect(configureLinuxSecretServiceBackend({ platform: "win32", commandLine })).toBe(false);
  });

  it("accepts only protected Electron backends", () => {
    expect(linuxProtectedStorageAvailable({ backend: "gnome_libsecret", encryptionAvailable: true })).toBe(true);
    expect(linuxProtectedStorageAvailable({ backend: "kwallet6", encryptionAvailable: true })).toBe(true);
    expect(linuxProtectedStorageAvailable({ backend: "basic_text", encryptionAvailable: true })).toBe(false);
    expect(linuxProtectedStorageAvailable({ backend: "unknown", encryptionAvailable: true })).toBe(false);
    expect(linuxProtectedStorageAvailable({ backend: undefined, encryptionAvailable: true })).toBe(false);
    expect(linuxProtectedStorageAvailable({ backend: "gnome_libsecret", encryptionAvailable: false })).toBe(false);
  });

  it("keeps electron-builder package.json aligned with Secret Service metadata", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const pacmanFpm = packageJson.build?.pacman?.fpm ?? [];
    const debRecommends = packageJson.build?.deb?.recommends ?? [];
    const debDepends = packageJson.build?.deb?.depends ?? [];
    const pacmanDepends = packageJson.build?.pacman?.depends ?? [];

    for (const dependency of LINUX_PACMAN_SECRET_DEPENDS) expect(pacmanDepends).toContain(dependency);
    for (const dependency of LINUX_DEB_SECRET_DEPENDS) expect(debDepends).toContain(dependency);
    for (const entry of LINUX_PACMAN_SECRET_OPTDEPENDS) {
      expect(pacmanFpm).toContain(`--pacman-optional-depends=${entry}`);
    }
    for (const recommend of LINUX_DEB_SECRET_RECOMMENDS) {
      expect(debRecommends).toContain(recommend);
    }
  });
});
