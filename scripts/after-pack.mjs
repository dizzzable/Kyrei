import { installLinuxRootGuard } from "./linux-root-launcher.mjs";

/** @param {{ electronPlatformName: string, appOutDir: string, packager: { executableName: string } }} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  await installLinuxRootGuard({
    appOutDir: context.appOutDir,
    executableName: context.packager.executableName,
  });
}
