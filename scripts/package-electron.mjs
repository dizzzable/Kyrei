import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = resolve(dirname(scriptPath), "..");

/**
 * Run one packaging command without a shell so arguments remain portable and
 * cannot be reinterpreted by cmd.exe or /bin/sh.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string }} options
 */
export function runPackageCommand(command, args, { cwd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      rejectPromise(new Error(`${command} ${args.join(" ")} failed with ${detail}`));
    });
  });
}

async function installedElectronVersion(rootDir) {
  const manifest = JSON.parse(await readFile(join(rootDir, "node_modules", "electron", "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("installed-electron-version-missing");
  }
  return manifest.version;
}

async function installedNpmCli() {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard Node/npm installation layout.
    }
  }
  throw new Error("npm-cli-not-found");
}

/**
 * Use the Electron binary installed by npm only for a native, local package.
 * CI release jobs spell out their target architecture (and macOS builds two
 * architectures), so they must retain electron-builder's platform download.
 *
 * @param {string[]} builderArgs
 * @param {string | undefined} electronDist
 */
export function withLocalElectronDist(builderArgs, electronDist) {
  const hasExplicitArchitecture = builderArgs.some(argument =>
    ["--x64", "--arm64", "--ia32", "--universal"].includes(argument),
  );
  const hasElectronDist = builderArgs.some(argument =>
    argument === "--config.electronDist" || argument.startsWith("--config.electronDist="),
  );

  if (!electronDist || hasExplicitArchitecture || hasElectronDist) {
    return builderArgs;
  }

  return [...builderArgs, `--config.electronDist=${electronDist}`];
}

async function installedElectronDist(rootDir, builderArgs) {
  if (builderArgs.some(argument => ["--x64", "--arm64", "--ia32", "--universal"].includes(argument))) {
    return undefined;
  }

  const candidate = join(rootDir, "node_modules", "electron", "dist");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Package Kyrei with native modules compiled for Electron, then restore the
 * workspace copy for the Node runtime used by tests and development scripts.
 * electron-builder's non-forced rebuild may reuse better-sqlite3's Node ABI
 * artifact when Node and Electron embed different module ABIs.
 *
 * @param {{
 *   rootDir?: string,
 *   electronVersion?: string,
 *   npmCliPath?: string,
 *   builderArgs?: string[],
 *   run?: typeof runPackageCommand,
 * }} options
 */
export async function packageElectron({
  rootDir = defaultRootDir,
  electronVersion,
  npmCliPath,
  builderArgs = process.argv.slice(2),
  run = runPackageCommand,
} = {}) {
  const electronRebuildCli = join(rootDir, "node_modules", "@electron", "rebuild", "lib", "cli.js");
  const electronBuilderCli = join(rootDir, "node_modules", "electron-builder", "cli.js");
  const version = electronVersion ?? await installedElectronVersion(rootDir);
  const npmCli = npmCliPath ?? await installedNpmCli();
  const electronDist = await installedElectronDist(rootDir, builderArgs);

  await run(process.execPath, [npmCli, "run", "package:prepare"], { cwd: rootDir });

  let packagingError;
  try {
    // -f is essential: without it @electron/rebuild can accept the existing
    // Node 24 ABI 137 binary although Electron 43 requires ABI 148.
    await run(process.execPath, [
      electronRebuildCli,
      "-f",
      "-w",
      "better-sqlite3",
      "-v",
      version,
    ], { cwd: rootDir });
    await run(process.execPath, [electronBuilderCli, ...withLocalElectronDist(builderArgs, electronDist)], { cwd: rootDir });
  } catch (error) {
    packagingError = error;
  }

  let restoreError;
  try {
    await run(process.execPath, [npmCli, "rebuild", "better-sqlite3"], { cwd: rootDir });
  } catch (error) {
    restoreError = error;
  }

  if (packagingError && restoreError) {
    throw new AggregateError(
      [packagingError, restoreError],
      "Electron packaging failed and the Node native module could not be restored",
    );
  }
  if (packagingError) throw packagingError;
  if (restoreError) throw restoreError;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  packageElectron().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
