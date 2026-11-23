import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const familyJar = /^(?:io\.netty\.netty-|org\.bouncycastle\.|bcprov-|com\.fasterxml\.jackson\.|org\.freemarker\.freemarker-|com\.microsoft\.sqlserver\.mssql-jdbc-|com\.google\.guava\.guava-).*\.jar$/;

export async function repairDependencies(root, lock, download = fetch) {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.artifacts) || !lock.artifacts.length) {
    throw new Error("Invalid AS dependency lock");
  }
  const paths = new Set();
  for (const artifact of lock.artifacts) {
    if (!/^(lib\/lib\/main|bin\/client\/lib)\/[\w.-]+\.jar$/.test(artifact.path) || paths.has(artifact.path)) {
      throw new Error("Invalid or duplicate dependency path");
    }
    paths.add(artifact.path);
    const url = new URL(artifact.url);
    if (url.origin !== "https://repo.maven.apache.org" || !url.pathname.startsWith("/maven2/") || url.search || url.hash || url.username || url.password) {
      throw new Error("Dependency URL must use Maven Central");
    }
    for (const field of ["sha256", "originalSha256"]) {
      if (!/^[a-f0-9]{64}$/.test(artifact[field])) throw new Error("Dependency checksum missing");
    }
  }
  // Fail on upstream additions/removals, so no family member silently stays old.
  const installed = [];
  for (const dir of ["lib/lib/main", "bin/client/lib"]) {
    for (const name of await readdir(resolve(root, dir))) {
      if (familyJar.test(name)) installed.push(`${dir}/${name}`);
    }
  }
  if (installed.length !== paths.size || installed.some((path) => !paths.has(path))) {
    throw new Error("Upstream AS dependency inventory drift");
  }
  for (const artifact of lock.artifacts) {
    const path = resolve(root, artifact.path);
    if (!(await lstat(path)).isFile() || sha256(await readFile(path)) !== artifact.originalSha256) {
      throw new Error(`Upstream AS dependency checksum drift: ${artifact.path}`);
    }
  }
  // Download and verify every replacement before modifying the distribution.
  const replacements = [];
  for (const artifact of lock.artifacts) {
    const response = await download(artifact.url, { redirect: "error", signal: globalThis.AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Dependency download failed: ${artifact.artifact} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== artifact.sha256) throw new Error(`Dependency checksum mismatch: ${artifact.artifact}`);
    replacements.push({ artifact, bytes });
  }
  for (const { artifact, bytes } of replacements) {
    // Keep paths referenced by Quarkus' serialized application model and CLI
    // classpaths; the embedded Maven metadata identifies the replacement version.
    await writeFile(resolve(root, artifact.path), bytes);
  }
  await writeFile(resolve(root, "dependency-repair-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return replacements.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, lockPath] = process.argv.slice(2);
  if (!root || !lockPath) throw new Error("Usage: repair-partner-as-dependencies.mjs <keycloak-root> <lock.json>");
  const count = await repairDependencies(root, JSON.parse(await readFile(lockPath, "utf8")));
  console.log(`Verified and repaired ${count} AS dependency paths; augmentation still required.`);
}
