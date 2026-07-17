import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createLocalPostgres } from "../core/local-postgres.js";

describe("embedded Team Postgres runtime", () => {
  it("coalesces concurrent starts and exposes only a loopback connection", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kyrei-local-postgres-"));
    const db = { close: vi.fn(async () => undefined) };
    const server = {
      port: 54_321,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const pgliteFactory = vi.fn(async () => db);
    const socketServerFactory = vi.fn(() => server);
    const runtime = createLocalPostgres({
      dataDir,
      pgliteFactory,
      socketServerFactory,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    const [first, second] = await Promise.all([runtime.ensure(), runtime.ensure()]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: "ready",
      host: "127.0.0.1",
      port: 54_321,
      connectionString: "postgresql://postgres@127.0.0.1:54321/postgres?sslmode=disable",
    });
    expect(pgliteFactory).toHaveBeenCalledTimes(1);
    expect(socketServerFactory).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 0,
      maxConnections: 8,
    }));

    await runtime.close();
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toMatchObject({ state: "stopped", port: 0 });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("isolates persistent databases by workspace while serving one active project", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kyrei-local-postgres-scope-"));
    const databases = [
      { close: vi.fn(async () => undefined) },
      { close: vi.fn(async () => undefined) },
    ];
    const servers = [
      { port: 54_321, start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
      { port: 54_322, start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    ];
    let index = 0;
    const pgliteFactory = vi.fn(async () => databases[index]);
    const socketServerFactory = vi.fn(() => servers[index++]);
    const runtime = createLocalPostgres({
      dataDir,
      pgliteFactory,
      socketServerFactory,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    const first = await runtime.ensure("C:\\work\\alpha");
    const same = await runtime.ensure("c:/work/alpha");
    const second = await runtime.ensure("C:\\work\\beta");

    expect(same.connectionString).toBe(first.connectionString);
    expect(second.connectionString).not.toBe(first.connectionString);
    expect(pgliteFactory).toHaveBeenCalledTimes(2);
    expect(pgliteFactory.mock.calls[0]?.[0]).not.toBe(pgliteFactory.mock.calls[1]?.[0]);
    expect(servers[0].stop).toHaveBeenCalledTimes(1);
    expect(databases[0].close).toHaveBeenCalledTimes(1);

    await runtime.close();
    expect(servers[1].stop).toHaveBeenCalledTimes(1);
    expect(databases[1].close).toHaveBeenCalledTimes(1);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("serves the real PostgreSQL wire protocol with pgvector when bundled", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kyrei-local-postgres-real-"));
    const runtime = createLocalPostgres({ dataDir });
    let pool: Pool | undefined;
    try {
      const status = await runtime.ensure("/integration/team");
      expect(status.state).toBe("ready");
      expect(status.host).toBe("127.0.0.1");
      if (status.state !== "ready" || !status.connectionString) throw new Error(status.error ?? "local_postgres_not_ready");
      pool = new Pool({ connectionString: status.connectionString, max: 1 });
      const result = await pool.query<{ value: number }>("SELECT 1 AS value");
      expect(result.rows[0]?.value).toBe(1);
      if (status.vector) {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const vectorResult = await pool.query<{ value: string }>("SELECT '[1,2,3]'::vector::text AS value");
        expect(vectorResult.rows[0]?.value).toBe("[1,2,3]");
      }
    } finally {
      await pool?.end();
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
