import { describe,it,expect } from "vitest";
import { readBoundedResponse } from "../partner/bounded-response";

describe("partner dependency response bounds",()=>{
  it("enforces bytes across chunks, cancels oversized streams before parsing",async()=>{
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(3));controller.enqueue(new Uint8Array(3));},
      cancel(){cancelled=true;}});
    await expect(readBoundedResponse(new Response(stream),5)).rejects.toThrow("byte limit");
    expect(cancelled).toBe(true);
  });
  it("decodes split UTF-8 only after bounded collection and accepts empty bodies",async()=>{
    const bytes=new TextEncoder().encode("Đúng");
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes.slice(0,1));controller.enqueue(bytes.slice(1));controller.close();}});
    expect(await readBoundedResponse(new Response(stream),bytes.length)).toBe("Đúng");
    expect(await readBoundedResponse(new Response(null,{status:204}),1)).toBe("");
  });
});
