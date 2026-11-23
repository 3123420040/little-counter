import type { ReplyPlan } from "@medusa-snus/contracts";
import { filterBlockedClaims, DEFAULT_BLOCKED_PATTERNS } from "@medusa-snus/domain";
import { OpenAICompatibleProvider } from "./openai-provider.js";

export interface AiProviderPort {
  draftReply(input: {
    customerMessage: string;
    products: Array<{ id: string; name: string; price: number; stockLevel: number }>;
    operatorInstruction?: string;
  }): Promise<ReplyPlan>;
}

export class DeterministicProvider implements AiProviderPort {
  async draftReply(input: {
    customerMessage: string;
    products: Array<{ id: string; name: string; price: number; stockLevel: number }>;
    operatorInstruction?: string;
  }): Promise<ReplyPlan> {
    const { customerMessage, products } = input;
    const blocked = filterBlockedClaims(customerMessage);

    let responseText: string;
    let confidence: number;
    let riskLevel: ReplyPlan["riskLevel"];

    if (blocked.blocked) {
      responseText = "Dạ em xin phép không tư vấn về vấn đề sức khỏe ạ. Anh/chị cần hỗ trợ gì về sản phẩm không ạ?";
      confidence = 1.0;
      riskLevel = "blocked";
    } else if (products.length > 0) {
      const prodList = products.map(p => {
        const stock = p.stockLevel > 0 ? `Còn ${p.stockLevel}` : "Hết hàng";
        return `${p.name} (${p.price.toLocaleString("vi-VN")} VND, ${stock})`;
      }).join("; ");
      responseText = `Dạ chào anh/chị, bên em hiện có: ${prodList}. Anh/chị cần số lượng bao nhiêu ạ?`;
      confidence = 0.91;
      riskLevel = "low";
    } else if (customerMessage.toLowerCase().includes("giá") || customerMessage.toLowerCase().includes("bao nhiêu")) {
      responseText = "Dạ anh/chị vui lòng cho biết sản phẩm cụ thể để em báo giá chính xác ạ.";
      confidence = 0.85;
      riskLevel = "low";
    } else if (customerMessage.toLowerCase().includes("còn") || customerMessage.toLowerCase().includes("hàng")) {
      responseText = "Dạ anh/chị cho em xin tên sản phẩm để em kiểm tra tồn kho ạ.";
      confidence = 0.85;
      riskLevel = "low";
    } else if (customerMessage.length < 5) {
      responseText = "Dạ em có thể giúp gì cho anh/chị ạ?";
      confidence = 0.6;
      riskLevel = "medium";
    } else {
      responseText = "Dạ em có thể giúp gì cho anh/chị ạ?";
      confidence = 0.7;
      riskLevel = "low";
    }

    // Validate the response through policy
    const responseCheck = filterBlockedClaims(responseText);
    if (responseCheck.blocked) {
      riskLevel = "blocked";
      responseText = "[BLOCKED] Draft contains blocked claims - operator review required";
    }

    return {
      intent: blocked.blocked ? "health_inquiry" : "product_inquiry",
      riskLevel,
      customerLanguage: "vi",
      responseText,
      nextBestAction: products.length > 0 ? "suggest_products" : "ask_order_details",
      missingInformation: products.length === 0 ? ["product_name"] : [],
      confidence,
    };
  }
}

export function createAiProvider(): AiProviderPort {
  const provider = process.env.AI_PROVIDER || "deterministic";
  if (provider === "openai-compatible") {
    return new OpenAICompatibleProvider();
  }
  return new DeterministicProvider();
}
