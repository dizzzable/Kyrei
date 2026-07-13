import { describe, expect, it } from "vitest";
import {
  parseProviderModels,
  validateProviderCredentials,
  validateProviderDraft,
} from "./provider-validation";

describe("provider profile validation", () => {
  it("normalizes duplicate model ids while preserving order", () => {
    expect(parseProviderModels("gpt-4o-mini, gpt-4o\ngpt-4o-mini")).toEqual([
      { id: "gpt-4o-mini" },
      { id: "gpt-4o" },
    ]);
  });

  it("requires a name, an HTTP(S) base URL, and at least one model", () => {
    expect(validateProviderDraft({ name: "", baseURL: "https://api.example.com/v1", models: "gpt-4o" })).toEqual({
      ok: false,
      code: "settings.providers.error.nameRequired",
    });
    expect(validateProviderDraft({ name: "Example", baseURL: "file:///tmp/model", models: "gpt-4o" })).toEqual({
      ok: false,
      code: "settings.providers.error.baseUrlInvalid",
    });
    expect(validateProviderDraft({ name: "Example", baseURL: "https://api.example.com/v1", models: "" })).toEqual({
      ok: false,
      code: "settings.providers.error.modelRequired",
    });
  });

  it("accepts a complete provider profile", () => {
    expect(validateProviderDraft({
      name: "Example",
      baseURL: "https://api.example.com/v1",
      models: "gpt-4o-mini",
    })).toEqual({ ok: true, models: [{ id: "gpt-4o-mini" }] });
  });
});

describe("provider credential validation", () => {
  it("accepts Bedrock bearer credentials or a complete AWS key pair", () => {
    expect(validateProviderCredentials("amazon-bedrock", { region: "us-east-1", apiKey: "token" })).toEqual({ ok: true });
    expect(validateProviderCredentials("amazon-bedrock", {
      region: "us-east-1",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret",
    })).toEqual({ ok: true });
    expect(validateProviderCredentials("amazon-bedrock", { region: "us-east-1", accessKeyId: "AKIA_TEST" })).toEqual({
      ok: false,
      code: "settings.providers.error.bedrockCredentials",
    });
  });

  it("requires every Vertex service-account field", () => {
    expect(validateProviderCredentials("google-vertex", {
      project: "project",
      location: "us-central1",
      clientEmail: "agent@example.iam.gserviceaccount.com",
      privateKey: "private-key",
    })).toEqual({ ok: true });
    expect(validateProviderCredentials("google-vertex", { project: "project" })).toEqual({
      ok: false,
      code: "settings.providers.error.vertexCredentials",
    });
  });
});
