import type { IncomingMessage,ServerResponse } from "node:http";
import { partnerMcpHttp } from "@medusa-snus/application/partner-mcp";

// Raw Node boundary: the SDK owns Streamable HTTP responses. Exact /mcp
// middleware disables Medusa's parser so authentication precedes body parsing.
export const POST=(req:IncomingMessage,res:ServerResponse)=>partnerMcpHttp(req,res);
export const GET=POST;
export const DELETE=POST;
export const PUT=POST;
export const PATCH=POST;
export const OPTIONS=POST;
export const HEAD=POST;
