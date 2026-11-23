import { describe,expect,it } from "vitest";
import { partnerMcpTools,partnerOpenApi,isPartnerSchema } from "../partner-api";

const inputs:Record<string,Record<string,unknown>>={
  get_partner_context:{},list_products:{store_id:"store_a",limit:100},
  get_inventory:{store_id:"store_a",variant_ids:["variant_a"]},
  get_catalog_summary:{store_id:"store_a"},
  create_quote:{store_id:"store_a",items:[{variant_id:"variant_a",quantity:2}],fulfillment_mode:"pickup"},
  book_order:{store_id:"store_a",quote_id:"pq_a",external_order_id:"stable_a",payment_method:"cod",fulfillment:{mode:"pickup"}},
  list_orders:{store_id:"store_a",external_order_id:"stable_a"},get_order:{store_id:"store_a",order_id:"order_a"},
};
const problem={type:"urn:snus:partner:error:rate_limit_exceeded",title:"Rate limit exceeded",status:429,
  code:"rate_limit_exceeded",detail:"Rate limit exceeded",request_id:"req_a",retryable:true,retry_after_seconds:1};

describe("Remote MCP tool contracts preserve the REST business DTOs",()=>{
  it.each(["create_quote", "book_order"])("rejects unsupported fee fields at the %s MCP boundary without rewriting arguments", name => {
    const tool = partnerMcpTools.find(value => value.name === name)!;
    for (const fee of [{ paymentFeeType: "percent", paymentFeeValue: 0 }, { paymentFeeType: "percent", paymentFeeValue: 2 },
      { payment_fee_type: "amount", payment_fee_value: 1000 }, { paymentFeeMinor: 1000 }]) {
      const args = { ...inputs[name], ...fee }, bytes = JSON.stringify(args);
      expect(tool.validInput(args)).toBe(false);
      expect(JSON.stringify(args)).toBe(bytes);
    }
    expect(tool.validInput(inputs[name])).toBe(true);
  });
  it("publishes precisely eight bounded tools with output schemas and accurate side-effect hints",()=>{
    expect(partnerMcpTools.map(t=>t.name).sort()).toEqual(Object.keys(inputs).sort());
    for(const tool of partnerMcpTools){
      expect(tool.definition.outputSchema.type).toBe("object");
      expect(tool.definition.inputSchema.additionalProperties).toBe(false);
      expect(tool.definition.annotations.readOnlyHint).toBe(!["quotes","book"].includes(tool.operation));
    }
  });
  it("requires catalog and inventory scope together for the aggregate tool",()=>{
    const summary=partnerMcpTools.find(t=>t.name==="get_catalog_summary")!;
    expect(summary.requiredScopes).toEqual(["catalog:read","inventory:read"]);
  });
  it.each(partnerMcpTools)("accepts supported $name arguments and rejects identity/URL/approval injection",tool=>{
    expect(tool.validInput(inputs[tool.name])).toBe(true);
    for(const field of ["merchant_id","partner_id","actor_id","client_id","key_id","authorization","url","confirmed"]){
      expect(tool.validInput({...inputs[tool.name],[field]:"injected"})).toBe(false);
    }
  });
  it.each(partnerMcpTools)("requires an explicit safe error envelope and bounded retry metadata for $name",tool=>{
    expect(tool.validOutput({ok:false,error:problem})).toBe(true);
    expect(tool.validOutput({ok:true,error:problem})).toBe(false);
    expect(tool.validOutput({ok:false,error:{...problem,retry_after_seconds:0}})).toBe(false);
    expect(tool.validOutput({ok:false,error:{...problem,retry_after_seconds:3601}})).toBe(false);
    expect(tool.validOutput({ok:false,error:{...problem,authorization:"secret"}})).toBe(false);
  });
  it("keeps booking references mandatory and rejects caller idempotency keys and mutable pricing",()=>{
    const book=partnerMcpTools.find(t=>t.operation==="book")!;
    const {external_order_id:_external,...missing}=inputs.book_order;
    expect(book.validInput(missing)).toBe(false);
    for(const field of ["idempotency_key","price","amount_received","paid","discount"]){
      expect(book.validInput({...inputs.book_order,[field]:1})).toBe(false);
    }
    expect(book.definition.description).toContain("timeout does not prove rollback");
  });
  it("does not coerce numeric strings or permit pages/carts over the REST limits",()=>{
    const catalog=partnerMcpTools.find(t=>t.name==="list_products")!;
    for(const limit of ["20",101,0,-1,1.5])expect(catalog.validInput({store_id:"s",limit})).toBe(false);
    const quote=partnerMcpTools.find(t=>t.operation==="quotes")!;
    expect(quote.validInput({...inputs.create_quote,items:Array(51).fill({variant_id:"v",quantity:1})})).toBe(false);
  });
  it("preserves the REST OAuth identity schema while the MCP context requires a real key discriminator",()=>{
    const schema=partnerOpenApi.components.schemas.Integration;
    expect(schema.properties.client_id.type).toBe("string");
    expect(isPartnerSchema("MeResponse",{data:{client_id:null,auth_method:"mcp_key",key_id:"a".repeat(32)},meta:{request_id:"req_a"}})).toBe(false);
    const context=partnerMcpTools.find(t=>t.operation==="me")!;
    const success=context.definition.outputSchema.oneOf[0] as {properties:{data:{properties:Record<string,unknown>}}};
    expect(success.properties.data.properties.client_id).toEqual({type:"null"});
    expect(success.properties.data.properties.auth_method).toEqual({const:"mcp_key"});
  });
});
