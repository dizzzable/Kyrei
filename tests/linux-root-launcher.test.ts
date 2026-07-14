import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_ELECTRON_SUFFIX,
  createLinuxRootGuardLauncher,
  installLinuxRootGuard,
} from "../scripts/linux-root-launcher.mjs";
import afterPack from "../scripts/after-pack.mjs";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const posixIt = process.platform === "win32" ? it.skip : it;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Linux root launcher", () => {
  it("gives a bilingual no-sudo explanation without disabling the sandbox", () => {
    const launcher = createLinuxRootGuardLauncher("kyrei");

    expect(launcher).toContain('id -u)" -eq 0');
    expect(launcher).toContain("sudo only to install or update");
    expect(launcher).toContain("Kyrei нужно запускать от обычного пользователя");
    expect(launcher).toContain('exec "$APP_DIR/kyrei-electron" "$@"');
    expect(launcher).toContain("Do not add --no-sandbox");
    expect(launcher).toContain('--no-sandbox|--no-sandbox=*)');
    expect(launcher).toContain("Kyrei refused --no-sandbox");
    expect(launcher).toContain("If this appeared while starting an AppImage");
    expect(launcher).not.toMatch(/exec .*--no-sandbox/);
  });

  posixIt("rejects --no-sandbox=value before Electron receives it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kyrei-linux-launcher-exec-"));
    temporaryDirectories.push(directory);
    const launcherPath = join(directory, "kyrei");
    const binDir = join(directory, "bin");
    await mkdir(binDir);
    await writeFile(launcherPath, createLinuxRootGuardLauncher("kyrei"), { mode: 0o755 });
    await writeFile(join(binDir, "id"), "#!/usr/bin/env sh\nprintf '1000\\n'\n", { mode: 0o755 });
    await chmod(launcherPath, 0o755);
    await chmod(join(binDir, "id"), 0o755);

    await expect(execFileAsync("sh", [launcherPath, "--no-sandbox=1"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Kyrei refused --no-sandbox"),
    });
  });

  it("keeps the public executable name while moving Electron behind the guard", async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), "kyrei-linux-launcher-"));
    temporaryDirectories.push(appOutDir);
    const electronPath = join(appOutDir, "kyrei");
    await writeFile(electronPath, "electron-binary-placeholder");

    await installLinuxRootGuard({ appOutDir, executableName: "kyrei" });

    await expect(readFile(join(appOutDir, `kyrei${LINUX_ELECTRON_SUFFIX}`), "utf8"))
      .resolves.toBe("electron-binary-placeholder");
    await expect(readFile(electronPath, "utf8")).resolves.toContain("Kyrei must run as your regular desktop user");
    // Windows test filesystems do not expose POSIX executable bits; the
    // packaging hook itself runs on the Linux release runner.
    if (process.platform !== "win32") {
      expect((await stat(electronPath)).mode & 0o111).not.toBe(0);
    }
  });

  it("rejects unsafe executable names instead of writing outside the package", async () => {
    expect(() => createLinuxRootGuardLauncher("../kyrei")).toThrow("safe executable name");
    await expect(installLinuxRootGuard({ appOutDir: tmpdir(), executableName: "../kyrei" }))
      .rejects.toThrow("safe executable name");
  });

  it("wires the guard through electron-builder's Linux afterPack context", async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), "kyrei-linux-after-pack-"));
    temporaryDirectories.push(appOutDir);
    await writeFile(join(appOutDir, "kyrei"), "electron-binary-placeholder");

    await afterPack({
      electronPlatformName: "linux",
      appOutDir,
      packager: { executableName: "kyrei" },
    });

    await expect(readFile(join(appOutDir, "kyrei"), "utf8"))
      .resolves.toContain("Kyrei must run as your regular desktop user");
    await expect(readFile(join(appOutDir, `kyrei${LINUX_ELECTRON_SUFFIX}`), "utf8"))
      .resolves.toBe("electron-binary-placeholder");
  });

  it("uses the non-legacy AppImage runtime without a hard-coded no-sandbox desktop argument", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(packageJson.build.afterPack).toBe("./scripts/after-pack.mjs");
    expect(packageJson.build.toolsets.appimage).toBe("1.0.3");
    expect(packageJson.build.appImage.executableArgs).toEqual([]);
  });
});
