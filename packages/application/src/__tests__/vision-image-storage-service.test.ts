import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readVisionStorageObject,
  uploadVisionStorageObject,
} from "../services/vision-image-storage-service";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("vision image storage boundaries", () => {
  it("rejects cross-bucket and traversal keys before provider access", async () => {
    vi.stubEnv("GOOGLE_VISION_REFERENCE_BUCKET", "snus-vision-ref-test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(readVisionStorageObject("gs://other-bucket/raw/image.jpg"))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(readVisionStorageObject("raw/../image.jpg"))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsafe object names before upload", async () => {
    vi.stubEnv("GOOGLE_VISION_REFERENCE_BUCKET", "snus-vision-ref-test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(uploadVisionStorageObject({
      objectName: "../escape.jpg",
      bytes: Buffer.from("image"),
      contentType: "image/jpeg",
    })).rejects.toMatchObject({ code: "validation_error", statusCode: 400 });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["oauth", "upload"])("aborts a stalled %s request so a scan can release its lifecycle lock", async stage => {
    const directory = await mkdtemp(join(tmpdir(), "vision-storage-timeout-"));
    try {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const credentials = join(directory, "synthetic.json");
      await writeFile(credentials, JSON.stringify({ client_email: "synthetic@fixture.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://fixture.invalid/oauth" }), { mode: 0o600 });
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentials);
      vi.stubEnv("GOOGLE_VISION_REFERENCE_BUCKET", "synthetic-vision-timeout");
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => { expect(milliseconds).toBe(5000); return realTimeout(10); });
      let aborted = false;
      const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url.startsWith("https://fixture.invalid/oauth") || url.startsWith("https://storage.googleapis.com/upload/")).toBe(true);
        if (stage === "upload" && url.endsWith("/oauth")) return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }), { status: 200 });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const signal = init!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => { aborted = true; reject(signal.reason); };
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
      });
      vi.stubGlobal("fetch", fetchSpy);
      vi.resetModules();
      const storage = await import("../services/vision-image-storage-service");
      await expect(storage.uploadVisionStorageObject({ objectName: "synthetic/image.jpg", bytes: Buffer.from("synthetic"), contentType: "image/jpeg" }))
        .rejects.toMatchObject({ name: "TimeoutError" });
      expect(aborted).toBe(true); expect(fetchSpy).toHaveBeenCalledTimes(stage === "oauth" ? 1 : 2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
