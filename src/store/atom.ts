/**
 * Tiny reactive store on top of `useSyncExternalStore` (Wave 0.1).
 *
 * Decision (spec design §Стейт-менеджмент): use a zero-dependency mini-store
 * instead of nanostores. `atom(initial)` holds a value with get/set/subscribe;
 * `useAtom` subscribes a React component; `computed` derives from atoms;
 * `persistentAtom` mirrors to localStorage. Granular subscriptions keep the
 * streaming path from re-rendering the whole tree (Property 1).
 */

import { useRef, useSyncExternalStore } from "react";
import { persistJson, persistString, storedJson, storedString } from "@/lib/persist";

export interface Atom<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function atom<T>(initial: T): Atom<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe a component to an atom (optionally selecting a slice). */
export function useAtom<T>(a: Atom<T>): T;
export function useAtom<T, S>(a: Atom<T>, selector: (v: T) => S): S;
export function useAtom<T, S>(a: Atom<T>, selector?: (v: T) => S): T | S {
  // getSnapshot MUST return a referentially-stable value while the underlying
  // atom is unchanged, or useSyncExternalStore loops forever (React #185). A
  // selector often builds a fresh object each call (e.g. `{ ...defaults, ...v }`),
  // so we cache the selected result keyed on the atom's raw value reference —
  // atoms only mint a new reference when their value actually changes.
  const cache = useRef<{ raw: T; selected: S } | null>(null);

  const getSnapshot = (): T | S => {
    const raw = a.get();
    if (!selector) return raw;
    if (cache.current && Object.is(cache.current.raw, raw)) return cache.current.selected;
    const selected = selector(raw);
    cache.current = { raw, selected };
    return selected;
  };

  return useSyncExternalStore(a.subscribe, getSnapshot, getSnapshot);
}

/** Read-only atom derived from one or more source atoms. */
export function computed<T>(sources: Atom<unknown>[], compute: () => T): Atom<T> {
  const derived = atom(compute());
  for (const s of sources) s.subscribe(() => derived.set(compute()));
  return { get: derived.get, set: () => {}, subscribe: derived.subscribe };
}

/** Atom mirrored to localStorage as JSON. */
export function persistentJsonAtom<T>(key: string, fallback: T): Atom<T> {
  const a = atom<T>(storedJson(key, fallback));
  return {
    get: a.get,
    set(next) {
      a.set(next);
      persistJson(key, a.get());
    },
    subscribe: a.subscribe,
  };
}

/** Atom mirrored to localStorage as a plain string. */
export function persistentStringAtom(key: string, fallback = ""): Atom<string> {
  const a = atom<string>(storedString(key, fallback));
  return {
    get: a.get,
    set(next) {
      a.set(next);
      persistString(key, a.get());
    },
    subscribe: a.subscribe,
  };
}
