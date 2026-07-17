import { describe, expect, it, vi } from "vitest";
import {
  checkForAppUpdate,
  compareSemver,
  isAllowedUpdateUrl,
  normalizeVersion,
  parseLatestReleasePayload,
  releaseTagUrl,
} from "./app-update";

describe("normalizeVersion / compareSemver", () => {
  it("normalizes tags and plain versions", () => {
    expect(normalizeVersion("v0.4.2")).toBe("0.4.2");
    expect(normalizeVersion("0.4")).toBe("0.4.0");
    expect(normalizeVersion(" 1.2.3-beta ")).toBe("1.2.3");
    expect(normalizeVersion("nope")).toBe("");
  });

  it("orders major.minor.patch", () => {
    expect(compareSemver("0.4.1", "0.4.2")).toBeLessThan(0);
    expect(compareSemver("v0.4.2", "0.4.2")).toBe(0);
    expect(compareSemver("0.5.0", "0.4.9")).toBeGreaterThan(0);
  });
});

describe("isAllowedUpdateUrl", () => {
  it("allows only this repo releases over https", () => {
    expect(isAllowedUpdateUrl("https://github.com/dizzzable/Kyrei/releases")).toBe(true);
    expect(isAllowedUpdateUrl("https://github.com/dizzzable/Kyrei/releases/tag/v0.4.2")).toBe(true);
    expect(isAllowedUpdateUrl("https://github.com/dizzzable/Kyrei/releases/download/v0.4.2/x.exe")).toBe(true);
    expect(isAllowedUpdateUrl("https://github.com/evil/Kyrei/releases")).toBe(false);
    expect(isAllowedUpdateUrl("http://github.com/dizzzable/Kyrei/releases")).toBe(false);
    expect(isAllowedUpdateUrl("https://evil.com/dizzzable/Kyrei/releases")).toBe(false);
  });
});

describe("parseLatestReleasePayload", () => {
  it("reports available when latest is newer", () => {
    const result = parseLatestReleasePayload({
      tag_name: "v0.5.0",
      html_url: "https://github.com/dizzzable/Kyrei/releases/tag/v0.5.0",
      name: "Kyrei v0.5.0",
    }, "0.4.2");
    expect(result).toMatchObject({
      status: "available",
      currentVersion: "0.4.2",
      latestVersion: "0.5.0",
      releaseName: "Kyrei v0.5.0",
    });
  });

  it("reports up_to_date when current matches or is newer", () => {
    expect(parseLatestReleasePayload({
      tag_name: "v0.4.2",
      html_url: "https://github.com/dizzzable/Kyrei/releases/tag/v0.4.2",
    }, "0.4.2").status).toBe("up_to_date");
    expect(parseLatestReleasePayload({
      tag_name: "v0.4.0",
      html_url: "https://github.com/dizzzable/Kyrei/releases/tag/v0.4.0",
    }, "0.4.2").status).toBe("up_to_date");
  });

  it("rejects disallowed html_url", () => {
    expect(parseLatestReleasePayload({
      tag_name: "v1.0.0",
      html_url: "https://evil.example/download",
    }, "0.1.0")).toMatchObject({ status: "error", error: "release_url_not_allowed" });
  });

  it("falls back to constructed tag url", () => {
    const result = parseLatestReleasePayload({ tag_name: "v0.9.0" }, "0.1.0");
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.releaseUrl).toBe(releaseTagUrl("v0.9.0"));
    }
  });
});

describe("checkForAppUpdate", () => {
  it("maps HTTP errors and network failures", async () => {
    const http = await checkForAppUpdate({
      currentVersion: "0.4.2",
      fetchImpl: vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    expect(http).toMatchObject({ status: "error", error: "http_404" });

    const net = await checkForAppUpdate({
      currentVersion: "0.4.2",
      fetchImpl: vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    });
    expect(net).toMatchObject({ status: "error", error: "network_error" });
  });

  it("parses a successful latest payload", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.4.2",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        tag_name: "v0.4.3",
        html_url: "https://github.com/dizzzable/Kyrei/releases/tag/v0.4.3",
        name: "Kyrei v0.4.3",
      }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({
      status: "available",
      latestVersion: "0.4.3",
    });
  });
});
