/// <reference types="vite/client" />

declare module "*.css";

/**
 * `d3-force-3d` ships no type declarations and has no `@types` package. Only
 * the forces the Atlas layout actually installs are declared — a positioning
 * force per axis and collision — rather than the whole module surface, so an
 * undeclared call is a compile error instead of `any`.
 */
declare module "d3-force-3d" {
  interface PositionForce<T> {
    (alpha: number): void;
    initialize?: (nodes: T[], ...rest: unknown[]) => void;
    strength: ((accessor: number | ((node: T, index: number) => number)) => PositionForce<T>) & (() => unknown);
  }
  interface CollideForce<T> {
    (alpha: number): void;
    initialize?: (nodes: T[], ...rest: unknown[]) => void;
    radius: (accessor: number | ((node: T, index: number) => number)) => CollideForce<T>;
    strength: (value: number) => CollideForce<T>;
    iterations: (value: number) => CollideForce<T>;
  }
  export function forceX<T>(accessor: number | ((node: T, index: number) => number)): PositionForce<T>;
  export function forceY<T>(accessor: number | ((node: T, index: number) => number)): PositionForce<T>;
  export function forceZ<T>(accessor: number | ((node: T, index: number) => number)): PositionForce<T>;
  export function forceCollide<T>(accessor?: number | ((node: T, index: number) => number)): CollideForce<T>;
}

/** Injected by Vite `define` from package.json. */
declare const __APP_VERSION__: string;
declare const __COMMIT_SHA__: string;
