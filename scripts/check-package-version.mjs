import { readFile } from "node:fs/promises";

const readJson = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));

const [manifest, lockfile] = await Promise.all([
  readJson("package.json"),
  readJson("package-lock.json"),
]);

const manifestVersion = manifest.version;
const lockfileVersion = lockfile.version;
const rootPackageVersion = lockfile.packages?.[""]?.version;

if (!manifestVersion || manifestVersion !== lockfileVersion || manifestVersion !== rootPackageVersion) {
  throw new Error(
    `Package version mismatch: package.json=${manifestVersion ?? "missing"}, `
    + `package-lock.json=${lockfileVersion ?? "missing"}, `
    + `package-lock packages[\"\"].version=${rootPackageVersion ?? "missing"}`,
  );
}

console.log(`Package metadata version is consistent: ${manifestVersion}`);
