import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop release contract", () => {
  it("publishes updater metadata and differential blockmaps", async () => {
    const workflow = await readFile(
      resolve(process.cwd(), ".github", "workflows", "package-desktop.yml"),
      "utf8",
    );

    expect(workflow).toContain("dist/app/latest.yml");
    expect(workflow).toContain("dist/app/latest-mac.yml");
    expect(workflow).toContain("dist/app/latest-linux.yml");
    expect(workflow).toContain("dist/app/latest-linux-arm64.yml");
    expect(workflow).toContain("dist/app/*.blockmap");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run package:prepare");
    expect(workflow).toContain('node-version: "24"');
  });

  it("pins the Kyrei icon to every NSIS icon surface", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "package.json"), "utf8"),
    ) as {
      build?: {
        win?: { icon?: string };
        nsis?: {
          installerIcon?: string;
          uninstallerIcon?: string;
          installerHeaderIcon?: string;
        };
      };
    };

    expect(packageJson.build?.win?.icon).toBe("assets/icon.ico");
    expect(packageJson.build?.nsis).toMatchObject({
      installerIcon: "assets/icon.ico",
      uninstallerIcon: "assets/icon.ico",
      installerHeaderIcon: "assets/icon.ico",
    });
  });
});
