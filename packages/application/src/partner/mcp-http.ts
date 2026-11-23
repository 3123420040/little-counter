import type { IncomingMessage,ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema,ListToolsRequestSchema,InitializeRequestSchema,PingRequestSchema,JSONRPCMessageSchema,ErrorCode,McpError,SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { partnerMcpTools } from "@medusa-snus/contracts/partner-api";
import { getPartnerRuntime,logPartnerAttempt } from "./http";
import { newPartnerAttempt,type PartnerHttpResult,type PartnerInvocation } from "./runtime";
import { PartnerError,partnerProblem } from "./errors";
import type { PartnerIdentity } from "./registry";

class TransportError extends Error {constructor(readonly status:number,readonly code:number){super("Invalid MCP transport request");}}
function accepted(value:string|undefined){
  const media=new Set((value??"").split(",").flatMap(part=>{
    const [type,...parameters]=part.trim().toLowerCase().split(";").map(s=>s.trim());
    const qualities=parameters.filter(p=>p.startsWith("q="));
    if(qualities.length>1||qualities.some(p=>!/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(p)||Number(p.slice(2))===0))return [];
    return [type];
  }));
  return media.has("application/json")&&media.has("text/event-stream");
}
function readBody(req:IncomingMessage):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    if(req.destroyed||req.aborted){reject(new TransportError(400,ErrorCode.InvalidRequest));return;}
    const chunks:Buffer[]=[];let size=0;
    const cleanup=()=>{clearTimeout(timer);req.off("data",data);req.off("end",end);req.off("aborted",abort);req.off("error",abort);};
    const fail=(error:Error)=>{cleanup();req.pause();reject(error);};
    const abort=()=>fail(new TransportError(400,ErrorCode.InvalidRequest));
    const data=(chunk:Buffer)=>{size+=chunk.length;if(size>65536)fail(new PartnerError("payload_too_large"));else chunks.push(chunk);};
    const end=()=>{cleanup();try{resolve(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));}
      catch{reject(new TransportError(400,ErrorCode.ParseError));}};
    const timer=setTimeout(()=>fail(new TransportError(408,ErrorCode.InvalidRequest)),5000);
    req.on("data",data);req.once("end",end);req.once("aborted",abort);req.once("error",abort);
  });
}
function toolEnvelope(result:PartnerHttpResult){
  if(result.status<400)return {ok:true,...result.body as Record<string,unknown>};
  return {ok:false,error:{...result.body as Record<string,unknown>,
    ...(result.headers["Retry-After"]?{retry_after_seconds:Number(result.headers["Retry-After"])}:{})}};
}
let inflight=0;
export function partnerMcpTransportHealth(){return {inflight,max_inflight:40};}

/** Exact Medusa mount uses raw Node HTTP objects, with its default body parser
 * disabled. Every SDK server/transport and verified identity is request-local. */
export async function partnerMcpHttp(req:IncomingMessage & {originalUrl?:string},res:ServerResponse){
  const attempt=newPartnerAttempt(),started=performance.now();
  res.setHeader("Cache-Control","no-store");res.setHeader("X-Request-Id",attempt.requestId);
  let identity:PartnerIdentity|undefined,server:Server|undefined,businessLogged=false,errorCode:string|null=null;
  let controlAdmitted=false,toolName:string|undefined,rpcId:string|number|null=null;
  const admitControl=async()=>{
    if(!identity||controlAdmitted)return;
    controlAdmitted=true;
    await getPartnerRuntime().admitMcpControl(identity);
  };
  let active=false,closed=false;
  const cleanup=()=>{if(closed)return;closed=true;clearTimeout(deadline);res.off("finish",cleanup);res.off("close",cleanup);
    if(active){inflight--;active=false;}void server?.close().catch(()=>undefined);};
  const deadline=setTimeout(()=>{if(!res.writableEnded)res.destroy();cleanup();},10000);
  res.once("finish",cleanup);res.once("close",cleanup);
  try{
    if(process.env.PARTNER_MCP_ENABLED!=="true")throw new PartnerError("dependency_unavailable");
    if(inflight>=40)throw new PartnerError("mutation_busy");inflight++;active=true;
    const runtime=getPartnerRuntime(),settings=runtime.mcpSettings();
    if(req.headers.host!==settings.host||(req.originalUrl??req.url)!=="/mcp"||req.headers.cookie!==undefined)
      throw new TransportError(400,ErrorCode.InvalidRequest);
    const peer=req.socket.remoteAddress??"";
    const forwarded=req.headers["x-partner-client-ip"];
    const ip=settings.trustedProxyIps?.includes(peer)&&typeof forwarded==="string"&&isIP(forwarded)?forwarded:peer;
    if(!isIP(ip))throw new TransportError(400,ErrorCode.InvalidRequest);
    await runtime.admitMcpIp(ip);
    if(closed||req.destroyed||req.aborted||res.destroyed)return;
    if(req.headers.origin!==undefined&&!settings.allowedOrigins?.includes(req.headers.origin))throw new TransportError(403,ErrorCode.InvalidRequest);
    // Node discards some duplicate headers; reject ambiguity using raw headers.
    for(const name of ["authorization","origin","mcp-protocol-version","host"]){
      if(req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length>1)throw new TransportError(400,ErrorCode.InvalidRequest);
    }
    const authorization=req.headers.authorization??"";
    identity=await runtime.authenticateMcp(authorization,attempt);
    if(closed||req.destroyed||req.aborted||res.destroyed)return;
    if(req.method!=="POST"){res.setHeader("Allow","POST");throw new TransportError(405,ErrorCode.InvalidRequest);}
    if(!accepted(req.headers.accept))throw new TransportError(406,ErrorCode.InvalidRequest);
    if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"]??"")||req.headers["content-encoding"]!==undefined)
      throw new PartnerError("unsupported_media_type");
    if(Number(req.headers["content-length"]??0)>65536)throw new PartnerError("payload_too_large");
    const version=req.headers["mcp-protocol-version"];
    if(version!==undefined&&(typeof version!=="string"||!SUPPORTED_PROTOCOL_VERSIONS.includes(version)))throw new TransportError(400,ErrorCode.InvalidRequest);
    if(req.headers["mcp-session-id"]!==undefined)throw new TransportError(400,ErrorCode.InvalidRequest);
    const message=await readBody(req);
    if(!message||typeof message!=="object"||Array.isArray(message))throw new TransportError(400,ErrorCode.InvalidRequest);
    const rpc=message as Record<string,unknown>;
    if(rpc.id!==undefined&&!(typeof rpc.id==="string"&&rpc.id.length<=96||typeof rpc.id==="number"&&Number.isSafeInteger(rpc.id)))throw new TransportError(400,ErrorCode.InvalidRequest);
    const requestSchema=rpc.method==="initialize"?InitializeRequestSchema:rpc.method==="tools/list"?ListToolsRequestSchema:rpc.method==="ping"?PingRequestSchema:rpc.method==="tools/call"?CallToolRequestSchema:undefined;
    // Classify method parameter failures separately from malformed RPC syntax.
    // Invalid protocol envelopes cannot provide a trustworthy response id.
    if(rpc.jsonrpc==="2.0"&&rpc.id!==undefined&&requestSchema&&!requestSchema.safeParse(message).success){
      rpcId=rpc.id as string|number;throw new TransportError(400,ErrorCode.InvalidParams);
    }
    if(!JSONRPCMessageSchema.safeParse(message).success)throw new TransportError(400,ErrorCode.InvalidRequest);
    rpcId=typeof rpc.id==="string"||typeof rpc.id==="number"?rpc.id:null;
    const parsedCall=CallToolRequestSchema.safeParse(message);
    if(rpc.method==="tools/call"&&!parsedCall.success)throw new TransportError(400,ErrorCode.InvalidParams);
    if(parsedCall.success&&parsedCall.data.params.task!==undefined)throw new TransportError(400,ErrorCode.InvalidParams);
    const requestedTool=parsedCall.success?partnerMcpTools.find(tool=>tool.name===parsedCall.data.params.name):undefined;
    toolName=requestedTool?.name;
    // Only a well-formed, known business invocation proceeds to the shared
    // business buckets. Invalid calls and protocol messages share a finite
    // integration control budget, even if they fail before SDK dispatch.
    if(rpc.jsonrpc!=="2.0"||rpc.id===undefined||!parsedCall.success||!requestedTool?.validInput(parsedCall.data.params.arguments??{}))await admitControl();
    server=new Server({name:"snus-partner",version:"2.2.0"},{capabilities:{tools:{listChanged:false}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:partnerMcpTools
      .filter(tool=>identity!.grants.some(grant=>tool.requiredScopes.every(scope=>grant.scopes.includes(scope)))).map(tool=>tool.definition)}));
    server.setRequestHandler(CallToolRequestSchema,async call=>{
      const tool=partnerMcpTools.find(tool=>tool.name===call.params.name);
      if(!tool)throw new McpError(ErrorCode.InvalidParams,"Unknown tool");
      const args=call.params.arguments??{};
      let result:PartnerHttpResult;
      if(!tool.validInput(args))result={status:400,headers:{},body:partnerProblem(new PartnerError("invalid_request"),attempt.requestId)};
      else if((tool.operation==="quotes"||tool.operation==="book")&&(process.env.PARTNER_MUTATIONS_ENABLED!=="true"
        ||tool.operation==="book"&&process.env.PARTNER_BOOKING_ENABLED!=="true")){
        await admitControl();
        result={status:503,headers:{"Retry-After":"1"},body:partnerProblem(new PartnerError("dependency_unavailable"),attempt.requestId)};
      }else{
        const input:PartnerInvocation={};
        if(tool.operation==="quotes"||tool.operation==="book")input.body=args;
        else {const {order_id,...query}=args;input.orderId=typeof order_id==="string"?order_id:undefined;
          input.query=Object.fromEntries(Object.entries(query).map(([key,value])=>[key,Array.isArray(value)?value.join(","):typeof value==="number"?String(value):value]));}
        result=await runtime.mcp(tool.operation,input,authorization,attempt);businessLogged=true;
      }
      const envelope=toolEnvelope(result);
      if(!tool.validOutput(envelope))throw new McpError(ErrorCode.InternalError,"Invalid tool output");
      if(result.status>=400)errorCode=String((result.body as Record<string,unknown>).code);
      return {isError:result.status>=400,structuredContent:envelope,content:[{type:"text" as const,text:JSON.stringify(envelope)}]};
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    const send=transport.send.bind(transport);
    transport.send=async(message,options)=>{
      if("error" in message)errorCode="mcp_protocol_error";
      return send(message,options);
    };
    await server.connect(transport);
    if(closed){await server.close();return;}
    await transport.handleRequest(req,res,message);
  }catch(caught){
    let error=caught;
    try{await admitControl();}catch(limited){error=limited;}
    const problem=partnerProblem(error,attempt.requestId);errorCode=error instanceof TransportError?"mcp_transport_error":problem.code;
    if(!res.headersSent&&!res.destroyed){
      res.statusCode=error instanceof TransportError?error.status:problem.status;
      res.setHeader("Content-Type","application/json");
      if(res.statusCode===401)res.setHeader("WWW-Authenticate",'Bearer realm="partner-mcp"');
      if(res.statusCode===429||res.statusCode===503)res.setHeader("Retry-After",String(error instanceof PartnerError?error.retryAfter:1));
      if(!req.complete)res.setHeader("Connection","close");
      res.end(JSON.stringify(error instanceof TransportError?{jsonrpc:"2.0",id:rpcId,error:{code:error.code,message:error.message},request_id:attempt.requestId}:problem));
    }
  }finally{
    if(!businessLogged)logPartnerAttempt({timestamp:new Date().toISOString(),service:"medusa-partner-api",
      environment:process.env.PARTNER_ENVIRONMENT==="production"?"production":"sandbox",
      release:process.env.BUILD_RELEASE_ID??"unconfigured",source:process.env.BUILD_SOURCE_COMMIT??"unknown",
      request_id:attempt.requestId,trace_id:attempt.traceId,span_id:attempt.spanId,transport:"mcp_http",
      ...(toolName?{tool_name:toolName}:{}),
      auth_method:identity?.authMethod??null,credential_id:identity?.credentialId??null,key_id:identity?.keyId??null,client_id:null,
      partner_id:identity?.partnerId??null,integration_id:identity?.integrationId??null,merchant_id:identity?.merchantId??null,
      store_id:null,grant_version:identity?.grantVersion??null,route:"/mcp",method:req.method==="GET"?"GET":"POST",
      status:res.statusCode,duration_ms:Math.round(performance.now()-started),outcome:errorCode||res.statusCode>=400||res.destroyed&&!res.writableEnded?"denied":"success",
      error_code:errorCode??(res.statusCode>=400?"mcp_transport_error":res.destroyed&&!res.writableEnded?"transport_disconnected":null),
      idempotency_replayed:false,client_correlation_id:null});
    if(res.writableEnded||res.destroyed)cleanup();
  }
}
