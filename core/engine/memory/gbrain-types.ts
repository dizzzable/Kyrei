/**
 * GBrain personal-memory type declarations.
 *
 * Types-only leaf module: contains no runtime imports so it can be depended on
 * by `../types.ts` (the shared engine type module) without pulling in the
 * GBrain implementation and the data-layer runtime it imports. The concrete
 * client/runner implementation lives in `./gbrain.ts`, which re-exports these
 * types for existing importers.
 */

export type GBrainMode = "off" | "read" | "read-write";
export type GBrainProvider = "builtin" | "external-cli";

export interface GBrainConfig {
  provider: GBrainProvider;
  mode: GBrainMode;
  /** Used only by the explicit `external-cli` compatibility provider. */
  command?: string;
  source?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GBrainRunOptions {
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type GBrainRunner = (
  command: string,
  args: string[],
  options: GBrainRunOptions,
) => Promise<string>;

export interface GBrainClientOptions extends GBrainConfig {
  runner?: GBrainRunner;
  signal?: AbortSignal;
  /** Gateway-owned local directory for the built-in provider. */
  dataDir?: string;
  sensitiveValues?: readonly string[];
}

export interface GBrainClient {
  search(query: string, limit?: number): Promise<unknown>;
  getPage(slug: string): Promise<unknown>;
  think(question: string, options?: { anchor?: string; rounds?: number }): Promise<unknown>;
  capture(content: string, options?: { slug?: string; type?: string }): Promise<unknown>;
  doctor(): Promise<unknown>;
}
