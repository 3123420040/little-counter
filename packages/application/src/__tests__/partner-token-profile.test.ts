import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createPartnerTokenVerifier } from "../partner/token";
let server:Server,key:CryptoKey,verify:ReturnType<typeof createPartnerTokenVerifier>;
const now=()=>Math.floor(Date.now()/1000);
beforeAll(async()=>{
  const pair=await generateKeyPair("RS256");key=pair.privateKey;const jwk={...await exportJWK(pair.publicKey),kid:"profile",alg:"RS256",use:"sig"};
  server=createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({keys:[jwk]}));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("No JWKS socket");
  verify=createPartnerTokenVerifier({issuer:"https://profile.invalid",audience:"partner-sandbox",environment:"sandbox",jwksUrl:`http://127.0.0.1:${address.port}/certs`});
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
async function token(changes:Record<string,unknown>={},header:Record<string,unknown>={}){
  return new SignJWT({iss:"https://profile.invalid",aud:"partner-sandbox",sub:"service-account",client_id:"synthetic-client",scope:"partner:read",typ:"Bearer",iat:now(),exp:now()+300,...changes})
    .setProtectedHeader({alg:"RS256",typ:"JWT",kid:"profile",...header}).sign(key);
}
it("accepts a valid signed profile and does not follow caller key URLs",async()=>{
  expect((await verify(`Bearer ${await token({},{jku:"https://attacker.invalid/jwks",x5u:"https://attacker.invalid/cert"})}`)).clientId).toBe("synthetic-client");
});
it.each([
  ["expired",()=>({exp:now()-31,iat:now()-300})],
  ["future nbf",()=>({nbf:now()+31})],
  ["future iat",()=>({iat:now()+31,exp:now()+300})],
  ["overlong lifetime",()=>({exp:now()+301})],
  ["ID token type",()=>({typ:"ID"})],
  ["wrong issuer",()=>({iss:"https://foreign.invalid"})],
  ["wrong audience",()=>({aud:"staff"})],
  ["missing subject",()=>({sub:undefined})],
  ["missing client",()=>({client_id:undefined})],
  ["missing expiry",()=>({exp:undefined})],
  ["missing issuance",()=>({iat:undefined})],
  ["missing scopes",()=>({scope:undefined})],
  ["nonpositive lifetime",()=>({exp:now(),iat:now()})],
] as const)("rejects signed %s",async(_label,changes)=>{
  await expect(verify(`Bearer ${await token(changes())}`)).rejects.toMatchObject({code:"invalid_token"});
});
it("rejects wrong protected type",async()=>{await expect(verify(`Bearer ${await token({},{typ:"at+jwt"})}`)).rejects.toMatchObject({code:"invalid_token"});});
