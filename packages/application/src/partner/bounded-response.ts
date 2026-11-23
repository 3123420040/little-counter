/** Enforce the byte ceiling while streaming, before allocating/parsing a body. */
export async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader=response.body.getReader();
  const chunks: Uint8Array[]=[];
  let bytes=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>maxBytes)throw new Error("Dependency response exceeds byte limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks,bytes).toString("utf8");
  } catch(error) {
    await reader.cancel().catch(()=>undefined);
    throw error;
  } finally {reader.releaseLock();}
}
