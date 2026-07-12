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
