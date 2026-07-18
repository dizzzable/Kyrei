export type TerminalStatus = "running" | "exited" | "failed";
export type TerminalStream = "stdout" | "stderr";
export type TerminalKind = "manual" | "agent";
export type DesktopPlatform = "linux" | "windows" | "macos" | "unknown";

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

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "disabled";

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
  canAutoInstall: boolean;
  reason?: string;
  packaged: boolean;
  portable: boolean;
  platform: string;
}

interface KyreiDesktopBridge {
  platform?: DesktopPlatform;
  getPathForFile?: (file: File) => string;
  workspace?: {
    choose: (locale: "en" | "ru") => Promise<{ canceled: boolean; path: string }>;
    validatePath: (path: string) => Promise<{ path: string }>;
  };
  shell?: {
    openExternal: (
      url: string,
      options?: { sessionVerificationUri?: string; codexAuthUri?: string },
    ) => Promise<{ ok: boolean }>;
  };
  appearance?: {
    setWindowTheme: (input: { color: string; symbolColor: string }) => Promise<boolean>;
  };
  update?: {
    getStatus: () => Promise<DesktopUpdateStatus>;
    check: () => Promise<DesktopUpdateStatus>;
    download: () => Promise<DesktopUpdateStatus>;
    install: () => Promise<{ ok: boolean }>;
    subscribe: (callback: (status: DesktopUpdateStatus) => void) => string;
    unsubscribe: (id: string) => boolean;
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

export const desktopRuntime = {
  platform: (): DesktopPlatform => bridge()?.platform ?? "unknown",
};

export const desktopShell = {
  available: () => Boolean(bridge()?.shell?.openExternal),
  openExternal: async (url: string, options?: { sessionVerificationUri?: string; codexAuthUri?: string }) => {
    const api = bridge()?.shell;
    if (!api?.openExternal) throw unavailable();
    return api.openExternal(url, options);
  },
};

export const desktopUpdate = {
  available: () => Boolean(bridge()?.update?.getStatus),
  getStatus: async () => {
    const api = bridge()?.update;
    if (!api?.getStatus) throw unavailable();
    return api.getStatus();
  },
  check: async () => {
    const api = bridge()?.update;
    if (!api?.check) throw unavailable();
    return api.check();
  },
  download: async () => {
    const api = bridge()?.update;
    if (!api?.download) throw unavailable();
    return api.download();
  },
  install: async () => {
    const api = bridge()?.update;
    if (!api?.install) throw unavailable();
    return api.install();
  },
  onStatus: (callback: (status: DesktopUpdateStatus) => void) => {
    const api = bridge()?.update;
    if (!api?.subscribe) return () => {};
    const id = api.subscribe(callback);
    return () => { if (id) api.unsubscribe(id); };
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
