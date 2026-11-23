import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stores: ["store_a"],
  memberships: [] as Array<{ scopeType:string; merchantId?:string; storeId?:string; roleKey?:string; platformRoleKey?:string }>,
  reportStores: ["store_a"],
  read: vi.fn(),
}));
vi.mock("../services/access-service", () => ({
  resolveScopeBootstrap: async () => ({
    access: { actorId: "operator_a", isPlatformAdmin: false, legacyOrganizationId: "org_default",
      memberships: state.memberships.map((membership, index) => ({
        ...membership, membershipId: `membership-${index}`, operatorId: "operator_a", status: "active", permissionIds: [],
      })), permissionIds: [], explicitPermissions: state.reportStores.map(storeId => ({
        grantId: storeId, operatorId: "operator_a", permissionId: "reports:read", scopeType: "store",
        merchantId: "merchant_a", storeId, grantedBy: "UAT", validFrom: "2026-01-01T00:00:00Z", validTo: null,
      })) },
    historicalMemberships: [], historicalExplicitPermissions: [], historicalStores: [],
    stores: state.stores.map(id => ({ id, merchantId: "merchant_a" })), reportOptions: [],
  }),
}));
vi.mock("@medusa-snus/application", () => {
  class PlatformError extends Error { constructor(readonly code:string,message:string,readonly statusCode:number){super(message);} }
  return {
    PlatformError, authenticateRequestActor: async(headers:Record<string,string>)=>{
      if(headers["x-channel"])throw new PlatformError("unauthorized","Channel token is not a staff JWT",401);
      return {operatorId:"operator_a",role:"owner"};
    },
    resolveChannelActor:async()=>({operatorId:"operator_a",role:"owner",channel:"telegram"}),
    enforceRateLimit:()=>undefined,requireActorPermission:async()=>undefined,
    resolveRequestAccess:async()=>({memberships:state.memberships,permissionIds:["reports:read"]}),
    resolveDashboardHistoryScope: async (...args: unknown[]) => {
      const service = await import("../services/historical-read-scope-service");
      return service.resolveDashboardHistoryScope(args[0] as never, {
        "x-report-merchant-id": "merchant_a", "x-report-store-ids": state.stores.join(","),
      });
    },
    requireReadableReportScope:async()=>({scopeKind:"report",merchantId:"merchant_a",storeIds:state.stores}),
    requireScopedActorPermission:async(_actor:unknown,permission:string,target:{storeId:string})=>{
      if(permission!=="reports:read" || !state.reportStores.includes(target.storeId))throw new PlatformError("forbidden","No report proof",403);
    },
    getDashboard:async()=>{state.read();return {data:{orderCount:0,totalRevenue:0,products:0,lowStock:0,daily:[]}};},
    getPartialFinancialFeatureDashboardV1:async()=>{state.read();return {headers:{},statusCode:200,body:{}};},
    sendPlatformError:(res:{status:(status:number)=>{json:(body:unknown)=>void}},error:PlatformError)=>res.status(error.statusCode||500).json({error:{code:error.code}}),
  };
});
import { GET as legacy } from "../../../../src/api/dashboard/route";
import { GET as admin } from "../../../../src/api/admin/dashboard/route";
import { GET as financial } from "../../../../src/api/admin/dashboard/partial-financial/route";

async function call(handler:typeof legacy,channel=false){
  let status=200;
  const res={status(code:number){status=code;return this;},json(){},setHeader(){}};
  await handler({headers:channel?{"x-channel":"telegram"}:{},query:{from:"2026-10-18",to:"2026-10-18"}} as never,res as never);
  return status;
}
beforeEach(()=>{state.stores=["store_a"];state.reportStores=["store_a"];state.memberships=[];state.read.mockReset();});
describe.each([["legacy",legacy],["admin",admin],["financial",financial]] as const)("recovery %s dashboard boundary",(_name,handler)=>{
  it.each([["manager",200],["staff",403]] as const)("keeps mapped channel %s audience at HTTP %s",async(roleKey,expected)=>{
    state.memberships=[{scopeType:"store",merchantId:"merchant_a",storeId:"store_a",roleKey}];
    expect(await call(handler,true)).toBe(expected);
  });
  it("denies staff despite owner token/union report grant, before reading financial data",async()=>{
    state.memberships=[{scopeType:"store",merchantId:"merchant_a",storeId:"store_a",roleKey:"staff"}];
    expect(await call(handler)).toBe(403);expect(state.read).not.toHaveBeenCalled();
  });
  it.each(["owner","manager","accountant"])("keeps scoped %s report access",async(roleKey)=>{
    state.memberships=[{scopeType:"store",merchantId:"merchant_a",storeId:"store_a",roleKey}];
    expect(await call(handler)).toBe(200);expect(state.read).toHaveBeenCalledOnce();
  });
  it("does not borrow manager A authority for staff B or mixed A+B",async()=>{
    state.memberships=[{scopeType:"store",merchantId:"merchant_a",storeId:"store_a",roleKey:"manager"},
      {scopeType:"store",merchantId:"merchant_a",storeId:"store_b",roleKey:"staff"}];
    state.reportStores=["store_a","store_b"];state.stores=["store_b"];
    expect(await call(handler)).toBe(403);state.stores=["store_a","store_b"];
    expect(await call(handler)).toBe(403);expect(state.read).not.toHaveBeenCalled();
  });
  it("requires a coupled target report proof even with platform authority",async()=>{
    state.memberships=[{scopeType:"platform",platformRoleKey:"platform_admin"}];state.reportStores=[];
    expect(await call(handler)).toBe(403);expect(state.read).not.toHaveBeenCalled();
    state.reportStores=["store_a"];expect(await call(handler)).toBe(200);
  });
});
