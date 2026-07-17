import { describe, expect, it } from "vitest";
import {
  LINUX_DEB_SECRET_RECOMMENDS,
  LINUX_PACMAN_SECRET_OPTDEPENDS,
  classifyLinuxDesktopFamily,
  describeLinuxSecretsEnvironment,
  formatLinuxSecretsUnavailableMessage,
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

  it("exports packaging metadata for Arch optdepends and Debian recommends", () => {
    expect(LINUX_PACMAN_SECRET_OPTDEPENDS.some((line) => line.startsWith("gnome-keyring:"))).toBe(true);
    expect(LINUX_PACMAN_SECRET_OPTDEPENDS.some((line) => line.startsWith("kwallet:"))).toBe(true);
    expect(LINUX_DEB_SECRET_RECOMMENDS).toContain("gnome-keyring");
    expect(linuxPacmanSecretServiceFpmArgs()).toEqual(
      LINUX_PACMAN_SECRET_OPTDEPENDS.map((entry) => `--pacman-optional-depends=${entry}`),
    );
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

    expect(pacmanDepends).toContain("libsecret");
    expect(debDepends).toContain("libsecret-1-0");
    for (const entry of LINUX_PACMAN_SECRET_OPTDEPENDS) {
      expect(pacmanFpm).toContain(`--pacman-optional-depends=${entry}`);
    }
    for (const recommend of LINUX_DEB_SECRET_RECOMMENDS) {
      expect(debRecommends).toContain(recommend);
    }
  });
});
