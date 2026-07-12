import { useEffect, useState } from "react";

function read<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function usePersistentNumber(key: string, initial: number) {
  const [value, setValue] = useState(() => read(key, initial, Number));
  useEffect(() => { write(key, String(value)); }, [key, value]);
  return [value, setValue] as const;
}

export function usePersistentBool(key: string, initial: boolean) {
  const [value, setValue] = useState(() => read(key, initial, r => r === "true"));
  useEffect(() => { write(key, String(value)); }, [key, value]);
  return [value, setValue] as const;
}

export function getStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function setStored(key: string, value: string): void {
  write(key, value);
}

// ── Non-hook localStorage helpers (for stores, Wave 0.1) ────────────────

export function storedString(key: string, fallback = ""): string {
  return read(key, fallback, r => r);
}

export function persistString(key: string, value: string): void {
  write(key, value);
}

export function storedBool(key: string, fallback: boolean): boolean {
  return read(key, fallback, r => r === "true");
}

export function persistBool(key: string, value: boolean): void {
  write(key, String(value));
}

export function storedJson<T>(key: string, fallback: T): T {
  return read(key, fallback, r => {
    try {
      return JSON.parse(r) as T;
    } catch {
      return fallback;
    }
  });
}

export function persistJson<T>(key: string, value: T): void {
  try {
    write(key, JSON.stringify(value));
  } catch {
    /* non-serializable / quota — best effort */
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
