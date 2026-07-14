import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";

const MAX_WORKSPACE_PATH_LENGTH = 32_768;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function workspacePathError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Canonicalise a renderer-supplied workspace path before it crosses into
 * desktop capabilities. The renderer may only nominate an existing absolute
 * directory; filesystem roots are deliberately excluded to avoid granting an
 * accidental whole-disk workspace.
 */
export async function validateWorkspacePath(value) {
  if (typeof value !== "string") throw workspacePathError("workspace_path_invalid");
  const candidate = value;
  if (
    !candidate
    || candidate !== candidate.trim()
    || candidate.length > MAX_WORKSPACE_PATH_LENGTH
    || CONTROL_CHARACTERS.test(candidate)
    || !isAbsolute(candidate)
  ) {
    throw workspacePathError("workspace_path_invalid");
  }

  const canonical = await realpath(candidate).catch(() => {
    throw workspacePathError("workspace_path_unavailable");
  });
  if (canonical.length > MAX_WORKSPACE_PATH_LENGTH || CONTROL_CHARACTERS.test(canonical)) {
    throw workspacePathError("workspace_path_invalid");
  }
  const metadata = await lstat(canonical).catch(() => {
    throw workspacePathError("workspace_path_unavailable");
  });
  if (!metadata.isDirectory()) throw workspacePathError("workspace_path_not_directory");
  if (canonical === parse(canonical).root) throw workspacePathError("workspace_path_root_forbidden");
  return canonical;
}

export { MAX_WORKSPACE_PATH_LENGTH };
