/// <reference types="vite/client" />

declare module "*.css";

/** Injected by Vite `define` from package.json. */
declare const __APP_VERSION__: string;

interface Window {
  kyrei?: {
    getPathForFile?: (file: File) => string;
  };
}
