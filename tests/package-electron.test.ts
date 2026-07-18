import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { packageElectron, withLocalElectronDist } from "../scripts/package-electron.mjs";

type CommandCall = [string, string[], { cwd: string }];

describe("Electron packaging", () => {
  it("uses a local Electron binary only for native package commands", () => {
    const electronDist = "C:\\kyrei\\node_modules\\electron\\dist";

    expect(withLocalElectronDist(["--win"], electronDist)).toEqual([
      "--win",
      `--config.electronDist=${electronDist}`,
    ]);
    expect(withLocalElectronDist(["--win", "--x64"], electronDist)).toEqual(["--win", "--x64"]);
    expect(withLocalElectronDist(["--win", "--config.electronDist=custom"], electronDist)).toEqual([
      "--win",
      "--config.electronDist=custom",
    ]);
  });

  it("force-rebuilds native modules for Electron and restores the Node ABI afterwards", async () => {
    const calls: CommandCall[] = [];
    const run = vi.fn(async (...args: CommandCall) => {
      calls.push(args);
    });

    await packageElectron({
      rootDir: "C:\\kyrei",
      electronVersion: "43.1.0",
      npmCliPath: "C:\\npm-cli.js",
      builderArgs: ["--win", "--dir"],
      run,
    });

    expect(calls).toEqual([
      [process.execPath, ["C:\\npm-cli.js", "run", "package:prepare"], { cwd: "C:\\kyrei" }],
      [
        process.execPath,
        [
          join("C:\\kyrei", "node_modules", "@electron", "rebuild", "lib", "cli.js"),
          "-f",
          "-w",
          "better-sqlite3",
          "-v",
          "43.1.0",
        ],
        { cwd: "C:\\kyrei" },
      ],
      [
        process.execPath,
        [join("C:\\kyrei", "node_modules", "electron-builder", "cli.js"), "--win", "--dir"],
        { cwd: "C:\\kyrei" },
      ],
      [process.execPath, ["C:\\npm-cli.js", "rebuild", "better-sqlite3"], { cwd: "C:\\kyrei" }],
    ]);
  });

  it("restores the Node ABI even when electron-builder fails", async () => {
    const calls: CommandCall[] = [];
    const buildError = new Error("packaging failed");
    const run = vi.fn(async (...args: CommandCall) => {
      calls.push(args);
      if (args[1].some(argument => argument.includes("electron-builder"))) throw buildError;
    });

    await expect(packageElectron({
      rootDir: "/kyrei",
      electronVersion: "43.1.0",
      npmCliPath: "/npm-cli.js",
      builderArgs: ["--linux"],
      run,
    })).rejects.toBe(buildError);

    expect(calls.at(-1)).toEqual([
      process.execPath,
      ["/npm-cli.js", "rebuild", "better-sqlite3"],
      { cwd: "/kyrei" },
    ]);
  });

  it("routes every release script through the ABI-safe packager", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const releaseScripts = Object.entries<string>(packageJson.scripts)
      .filter(([name]) => name === "dist" || name.startsWith("dist:"));

    expect(releaseScripts.length).toBeGreaterThan(0);
    for (const [, command] of releaseScripts) {
      expect(command).toContain("scripts/package-electron.mjs");
      expect(command).not.toContain("package:prepare && electron-builder");
    }
  });
});
