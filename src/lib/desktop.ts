export type TerminalStatus = "running" | "exited" | "failed";
export type TerminalStream = "stdout" | "stderr";
export type TerminalKind = "manual" | "agent";

export interface TerminalOutputChunk {
  stream: TerminalStream;
  text: string;
}

export interface TerminalSessionSnapshot {
  id: string;
  ownerId: string;
  kind: TerminalKind;
  actorId?: string;
  toolCallId?: string;
  title: string;
  cwd: string;
  status: TerminalStatus;
  output: TerminalOutputChunk[];
  exitCode: number | null;
  signal: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TerminalSessionEvent =
  | { type: "created" | "renamed" | "failed" | "exited"; session: TerminalSessionSnapshot }
  | { type: "output"; sessionId: string; stream: TerminalStream; text: string; updatedAt: string }
  | { type: "closed"; sessionId: string; ownerId: string };

interface KyreiDesktopBridge {
  getPathForFile?: (file: File) => string;
  workspace?: {
    choose: (locale: "en" | "ru") => Promise<{ canceled: boolean; path: string }>;
    validatePath: (path: string) => Promise<{ path: string }>;
  };
  terminal?: {
    list: (ownerId: string) => Promise<TerminalSessionSnapshot[]>;
    create: (input: { ownerId: string; title?: string; cwd?: string }) => Promise<TerminalSessionSnapshot>;
    write: (sessionId: string, data: string) => Promise<boolean>;
    rename: (sessionId: string, title: string) => Promise<TerminalSessionSnapshot>;
    close: (sessionId: string) => Promise<boolean>;
    subscribe: (callback: (event: TerminalSessionEvent) => void) => string;
    unsubscribe: (id: string) => boolean;
  };
}

declare global {
  interface Window {
    kyrei?: KyreiDesktopBridge;
  }
}

function unavailable(): Error {
  return new Error("desktop_capability_unavailable");
}

function bridge(): KyreiDesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kyrei;
}

export const desktopWorkspace = {
  available: () => Boolean(bridge()?.workspace),
  choose: async (locale: "en" | "ru") => {
    const api = bridge()?.workspace;
    if (!api) throw unavailable();
    return api.choose(locale);
  },
  validatePath: async (path: string) => {
    const api = bridge()?.workspace;
    if (!api) throw unavailable();
    return api.validatePath(path);
  },
};

export const desktopTerminal = {
  available: () => Boolean(bridge()?.terminal),
  list: async (ownerId: string) => {
    const api = bridge()?.terminal;
    if (!api) throw unavailable();
    return api.list(ownerId);
  },
  create: async (input: { ownerId: string; title?: string; cwd?: string }) => {
    const api = bridge()?.terminal;
    if (!api) throw unavailable();
    return api.create(input);
  },
  write: async (sessionId: string, data: string) => {
    const api = bridge()?.terminal;
    if (!api) throw unavailable();
    return api.write(sessionId, data);
  },
  rename: async (sessionId: string, title: string) => {
    const api = bridge()?.terminal;
    if (!api) throw unavailable();
    return api.rename(sessionId, title);
  },
  close: async (sessionId: string) => {
    const api = bridge()?.terminal;
    if (!api) throw unavailable();
    return api.close(sessionId);
  },
  onEvent: (callback: (event: TerminalSessionEvent) => void) => {
    const api = bridge()?.terminal;
    if (!api) return () => {};
    const id = api.subscribe(callback);
    return () => { if (id) api.unsubscribe(id); };
  },
};
