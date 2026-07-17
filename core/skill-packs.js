/**
 * Wave C2 — curated opt-in skill packs (ECC-selective, not a mega-repo dump).
 *
 * Packs ship with Kyrei under core/skill-packs/<packId>/ as read-only roots.
 * Enabling a pack adds its absolute path as a custom skills root (no copy).
 * Disabling removes that root. Never auto-enables; never rewrites user skills.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Built-in pack catalog (stable ids). */
export const BUILTIN_SKILL_PACKS = Object.freeze([
  {
    id: "security",
    name: "Security basics",
    description: "Local security checklist: secrets, path jail, permissions, destructive blast radius.",
    tags: ["security", "ecc-lite"],
  },
  {
    id: "research",
    name: "Research-first",
    description: "Deep research workflow for code + public web; untrusted web boundary; evidence before claims.",
    tags: ["research", "deepreep"],
  },
]);

/**
 * Absolute root of shipped packs (next to this module).
 * @returns {string}
 */
export function builtinSkillPacksRoot() {
  return join(HERE, "skill-packs");
}

/**
 * @param {string} packId
 * @returns {string}
 */
export function resolveBuiltinPackPath(packId) {
  const id = String(packId || "").trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
    throw Object.assign(new Error("invalid_pack_id"), { code: "invalid_pack_id" });
  }
  if (!BUILTIN_SKILL_PACKS.some((p) => p.id === id)) {
    throw Object.assign(new Error("pack_not_found"), { code: "pack_not_found" });
  }
  return join(builtinSkillPacksRoot(), id);
}

/**
 * @param {{ path?: string, canonical?: string }[]} roots
 * @param {string} packPath
 */
function rootMatchesPack(roots, packPath) {
  const target = packPath.replace(/\\/g, "/").toLowerCase();
  return (roots || []).some((r) => {
    const p = String(r.canonical || r.path || "").replace(/\\/g, "/").toLowerCase();
    return p === target;
  });
}

/**
 * List built-in packs with enablement derived from current skill roots.
 * @param {{ roots: () => Promise<Array<{ id?: string, path?: string, canonical?: string, provenance?: string }>> }} skillsStore
 */
export async function listSkillPacks(skillsStore) {
  const roots = typeof skillsStore?.roots === "function" ? await skillsStore.roots() : [];
  const packs = [];
  for (const meta of BUILTIN_SKILL_PACKS) {
    const path = resolveBuiltinPackPath(meta.id);
    let available = false;
    let skillCount = 0;
    try {
      const st = await stat(path);
      available = st.isDirectory();
      if (available) {
        const entries = await readdir(path, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            try {
              await stat(join(path, e.name, "SKILL.md"));
              skillCount += 1;
            } catch {
              /* skip */
            }
          }
        }
        // Pack may also place SKILL.md at root
        try {
          await stat(join(path, "SKILL.md"));
          skillCount += 1;
        } catch {
          /* ok */
        }
      }
    } catch {
      available = false;
    }
    packs.push({
      ...meta,
      path,
      available,
      skillCount,
      enabled: available && rootMatchesPack(roots, path),
    });
  }
  return packs;
}

/**
 * Enable a pack by adding its directory as a custom skills root.
 * @param {{ addRoot: (path: string) => Promise<unknown>, roots: () => Promise<unknown[]> }} skillsStore
 * @param {string} packId
 */
export async function enableSkillPack(skillsStore, packId) {
  const path = resolveBuiltinPackPath(packId);
  const st = await stat(path).catch(() => null);
  if (!st?.isDirectory()) {
    throw Object.assign(new Error("pack_unavailable"), { code: "pack_unavailable" });
  }
  const roots = await skillsStore.roots();
  if (rootMatchesPack(roots, path)) {
    return { ok: true, packId, path, already: true };
  }
  await skillsStore.addRoot(path);
  return { ok: true, packId, path, already: false };
}

/**
 * Disable a pack by removing its custom root.
 * @param {{ removeRoot: (idOrPath: string) => Promise<unknown>, roots: () => Promise<Array<{ id?: string, path?: string, canonical?: string }>> }} skillsStore
 * @param {string} packId
 */
export async function disableSkillPack(skillsStore, packId) {
  const path = resolveBuiltinPackPath(packId);
  const roots = await skillsStore.roots();
  const hit = (roots || []).find((r) => {
    const p = String(r.canonical || r.path || "").replace(/\\/g, "/").toLowerCase();
    return p === path.replace(/\\/g, "/").toLowerCase();
  });
  if (!hit) return { ok: true, packId, already: true };
  await skillsStore.removeRoot(hit.id || path);
  return { ok: true, packId, already: false };
}

/**
 * Optional pack README for UI/docs.
 * @param {string} packId
 */
export async function readPackReadme(packId) {
  const path = join(resolveBuiltinPackPath(packId), "README.md");
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
