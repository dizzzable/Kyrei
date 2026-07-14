import { spawn } from "node:child_process";

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SAFE_STORAGE_PREFIX = "kyrei-safe-storage-v1:";
const WINDOWS_DPAPI_PREFIX = "kyrei-windows-dpapi-v1:";

function dpapiError(code = "windows_dpapi_unavailable") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertBase64Payload(value) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES
    || !BASE64_RE.test(value)
  ) {
    throw dpapiError("windows_dpapi_payload_invalid");
  }
  return value;
}

function encodedPowerShellScript(mode) {
  if (mode !== "protect" && mode !== "unprotect") throw dpapiError("windows_dpapi_mode_invalid");
  const operation = mode === "protect" ? "Protect" : "Unprotect";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$payload = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($payload)",
    `$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Run Windows CurrentUser DPAPI without putting plaintext or ciphertext in
 * argv/environment. PowerShell receives only an encoded, credential-free
 * script in argv; the bounded payload travels over stdin.
 */
export function runWindowsDpapi(
  mode,
  payload,
  { spawnProcess = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const boundedPayload = assertBase64Payload(payload);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw dpapiError("windows_dpapi_timeout_invalid");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let outputBytes = 0;
    const child = spawnProcess("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedPowerShellScript(mode),
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (code) => {
      try { child.kill(); } catch { /* Process may already be gone. */ }
      finish(reject, dpapiError(code));
    };
    const timer = setTimeout(() => fail("windows_dpapi_timeout"), timeoutMs);
    timer.unref?.();

    child.once("error", () => fail("windows_dpapi_unavailable"));
    child.stdout?.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail("windows_dpapi_output_too_large");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    // Drain stderr, but never surface it: a platform error must not become a
    // channel that reflects credential-bearing stdin into logs or the UI.
    child.stderr?.on("data", () => {});
    child.once("close", (code) => {
      if (settled) return;
      const result = stdout.trim();
      if (code !== 0 || !BASE64_RE.test(result) || Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES) {
        fail("windows_dpapi_failed");
        return;
      }
      finish(resolve, result);
    });
    child.stdin?.once("error", () => fail("windows_dpapi_failed"));
    child.stdin?.end(boundedPayload, "utf8");
  });
}

/** Create and probe a codec compatible with the gateway secret envelope. */
export async function createWindowsDpapiSecretsCodec({ transform = runWindowsDpapi } = {}) {
  if (typeof transform !== "function") throw new TypeError("windows_dpapi_transform_invalid");
  const codec = {
    backend: "windows-dpapi",
    encode: async (value) => {
      if (typeof value !== "string") throw new TypeError("windows_dpapi_value_invalid");
      return transform("protect", Buffer.from(value, "utf8").toString("base64"));
    },
    decode: async (value) => {
      const decoded = await transform("unprotect", assertBase64Payload(value));
      return Buffer.from(assertBase64Payload(decoded), "base64").toString("utf8");
    },
  };

  const probe = `kyrei-dpapi-probe:${process.pid}`;
  if (await codec.decode(await codec.encode(probe)) !== probe) {
    throw dpapiError("windows_dpapi_probe_failed");
  }
  return codec;
}

function validCodec(value) {
  return value && typeof value.encode === "function" && typeof value.decode === "function";
}

/**
 * Version-tag Windows ciphertext so Electron safeStorage and the raw DPAPI
 * fallback can coexist across restarts. Untagged values remain readable for
 * installations created before the tagged envelope was introduced.
 */
export function createWindowsProtectedSecretsCodec({ safeStorageCodec, dpapiCodec } = {}) {
  const safe = validCodec(safeStorageCodec) ? safeStorageCodec : undefined;
  const dpapi = validCodec(dpapiCodec) ? dpapiCodec : undefined;
  if (!safe && !dpapi) throw dpapiError("windows_protected_storage_unavailable");

  const decodeWith = async (codec, value, code) => {
    if (!codec) throw dpapiError(code);
    return codec.decode(value);
  };

  return {
    backend: safe ? "electron-safe-storage" : "windows-dpapi",
    encode: async (value) => {
      if (safe) return `${SAFE_STORAGE_PREFIX}${await safe.encode(value)}`;
      return `${WINDOWS_DPAPI_PREFIX}${await dpapi.encode(value)}`;
    },
    decode: async (value) => {
      if (typeof value !== "string" || value.length > MAX_OUTPUT_BYTES * 2) {
        throw dpapiError("windows_protected_storage_payload_invalid");
      }
      if (value.startsWith(SAFE_STORAGE_PREFIX)) {
        return decodeWith(safe, value.slice(SAFE_STORAGE_PREFIX.length), "electron_safe_storage_unavailable");
      }
      if (value.startsWith(WINDOWS_DPAPI_PREFIX)) {
        return decodeWith(dpapi, value.slice(WINDOWS_DPAPI_PREFIX.length), "windows_dpapi_unavailable");
      }

      // Legacy envelopes carried no backend marker. Prefer Electron's decoder,
      // then try DPAPI so builds from the short-lived fallback remain recoverable.
      if (safe) {
        try { return await safe.decode(value); } catch { /* Try the fallback. */ }
      }
      if (dpapi) {
        try { return await dpapi.decode(value); } catch { /* Fail below. */ }
      }
      throw dpapiError("windows_protected_storage_decode_failed");
    },
  };
}
