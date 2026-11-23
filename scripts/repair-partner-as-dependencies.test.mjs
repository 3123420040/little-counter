import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { repairDependencies } from "./repair-partner-as-dependencies.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "partner-as-repair-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "lib/lib/main"), { recursive: true });
  await mkdir(resolve(root, "bin/client/lib"), { recursive: true });
  const path = "lib/lib/main/io.netty.netty-handler-4.1.136.Final.jar";
  await writeFile(resolve(root, path), "original");
  const artifact = { path, artifact: "netty-handler", url: "https://repo.maven.apache.org/maven2/test.jar", originalSha256: hash("original"), sha256: hash("patched") };
  return { root, path, lock: { schemaVersion: 1, artifacts: [artifact] } };
}
test("checksum failure leaves original distribution intact", async (t) => {
  const { root, path, lock } = await fixture(t);
  await assert.rejects(repairDependencies(root, lock, async () => new globalThis.Response("tampered")), /checksum mismatch/);
  assert.equal(await readFile(resolve(root, path), "utf8"), "original");
});
for (const name of ["io.netty.netty-buffer-4.1.136.Final.jar", "com.fasterxml.jackson.core.jackson-core-2.21.5.jar", "org.freemarker.freemarker-2.3.32.jar", "com.google.guava.guava-33.5.0-jre.jar"]) {
  test(`an untracked upstream family member ${name} fails before network or writes`, async (t) => {
    const { root, lock } = await fixture(t);
    await writeFile(resolve(root, "lib/lib/main", name), "new upstream");
    await assert.rejects(repairDependencies(root, lock, () => assert.fail("must not download")), /inventory drift/);
  });
}
test("original checksum drift fails before network", async (t) => {
  const { root, path, lock } = await fixture(t);
  await writeFile(resolve(root, path), "unexpected upstream");
  await assert.rejects(repairDependencies(root, lock, () => assert.fail("must not download")), /checksum drift/);
});
test("only locked bytes are written and the lock is retained for inventory", async (t) => {
  const { root, path, lock } = await fixture(t);
  assert.equal(await repairDependencies(root, lock, async () => new globalThis.Response("patched")), 1);
  assert.equal(await readFile(resolve(root, path), "utf8"), "patched");
  assert.deepEqual(JSON.parse(await readFile(resolve(root, "dependency-repair-lock.json"), "utf8")), lock);
});
test("path traversal and foreign download hosts are rejected", async (t) => {
  const { root, lock } = await fixture(t);
  lock.artifacts[0].path = "../escape.jar";
  await assert.rejects(repairDependencies(root, lock), /path/);
  lock.artifacts[0].path = "lib/lib/main/a.jar";
  lock.artifacts[0].url = "https://untrusted.invalid/test.jar";
  await assert.rejects(repairDependencies(root, lock), /Maven Central/);
});
