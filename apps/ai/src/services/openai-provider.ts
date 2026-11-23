// ═══════════════════════════════════════════════════════
// OpenAI-Compatible AI Provider
// Configurable via AI_PROVIDER=openai-compatible

// ═══════════════════════════════════════════════════════

import type { ReplyPlan } from "@medusa-snus/contracts";
import { filterBlockedClaims } from "@medusa-snus/domain";
import { createCircuitBreaker, withRetry } from "./circuit-breaker.js";
import * as applicationNamespace from "@medusa-snus/application";

const applicationModule = ((applicationNamespace as unknown as {
  default?: typeof import("@medusa-snus/application");
}).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const { safeErrorMetadata } = applicationModule;

const OPENAI_API_KEY = process.env.AI_API_KEY || "";
const OPENAI_ENDPOINT = process.env.AI_API_ENDPOINT || "https://api.deepseek.com";
const OPENAI_MODEL = process.env.AI_MODEL || "deepseek-v4-pro";
const REQUEST_TIMEOUT = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 30_000;

const breaker = createCircuitBreaker({ name: "openai", threshold: 5, resetMs: 60_000 });

function boundedText(value: unknown, maxLength: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

export class OpenAICompatibleProvider {
  async draftReply(input: {
    customerMessage: string;
    products: Array<{ id: string; name: string; price: number; stockLevel: number }>;
    operatorInstruction?: string;
  }): Promise<ReplyPlan> {
    if (!OPENAI_API_KEY) {
      console.warn("[AI] OpenAI API key not configured, falling back to deterministic");
      return deterministicReplyDraft(input);
    }

    return breaker.execute(async () => {
      return withRetry(
        async () => {
          const systemPrompt = buildSystemPrompt();
          const userMessage = buildUserMessage(input);

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

          try {
            const response = await fetch(`${OPENAI_ENDPOINT}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
              },
              body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: userMessage },
                ],
                temperature: 0.3,
                max_tokens: 500,
                response_format: { type: "json_object" },
              }),
              signal: controller.signal,
            });

            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              throw Object.assign(new Error("OpenAI provider request failed"), { statusCode: response.status });
            }

            const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
            const raw = data.choices?.[0]?.message?.content;
            if (typeof raw !== "string" || raw.length > 64 * 1024) {
              throw Object.assign(new Error("OpenAI response schema is invalid"), { retryable: false });
            }

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(raw);
            } catch {
              throw Object.assign(new Error("Failed to parse OpenAI response as JSON"), { retryable: false });
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw Object.assign(new Error("OpenAI response schema is invalid"), { retryable: false });
            }

            const plan: ReplyPlan = {
              intent: boundedText(parsed.intent, 64, "product_inquiry"),
              riskLevel: validateRiskLevel(String(parsed.riskLevel || "low")),
              customerLanguage: boundedText(parsed.customerLanguage, 16, "vi"),
              responseText: boundedText(parsed.responseText, 4_000),
              nextBestAction: validateNextAction(String(parsed.nextBestAction || "answer_question")),
              missingInformation: Array.isArray(parsed.missingInformation)
                ? parsed.missingInformation.slice(0, 20).map((item) => boundedText(item, 200)).filter(Boolean)
                : [],
              confidence: Number.isFinite(Number(parsed.confidence))
                ? Math.max(0, Math.min(1, Number(parsed.confidence)))
                : 0.7,
            };

            // Post-filter through policy engine
            const blocked = filterBlockedClaims(plan.responseText);
            if (blocked.blocked) {
              plan.riskLevel = "blocked";
            }

            return plan;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30_000 },
      );
    }).catch(async (err: unknown) => {
      console.error(JSON.stringify({
        level: "error",
        event: "ai_provider_fallback",
        provider: "openai_compatible",
        ...safeErrorMetadata(err),
      }));
      return deterministicReplyDraft(input);
    });
  }
}

async function deterministicReplyDraft(input: {
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

function buildSystemPrompt(): string {
  return `You are a retail sales assistant for a snus/nicotine pouch store in Vietnam. 

CRITICAL RULES:
- NEVER make health claims, medical claims, smoking cessation claims, or reduced-risk claims
- NEVER say products are "safer than" or "less harmful than" anything
- NEVER use words like: quit smoking, health benefit, therapeutic, medical, reduced risk, safer than, less harmful
- Answer in Vietnamese
- Be helpful, professional, concise
- Include product names, prices, and stock status when available

Respond in JSON format:
{
  "intent": "product_inquiry" | "order_request" | "general_question",
  "riskLevel": "low" | "medium" | "high" | "blocked",
  "customerLanguage": "vi",
  "responseText": "your response here",
  "nextBestAction": "answer_question" | "suggest_products" | "ask_order_details" | "handover_to_human",
  "missingInformation": [],
  "confidence": 0.0-1.0
}`;
}

function buildUserMessage(input: {
  customerMessage: string;
  products: Array<{ id: string; name: string; price: number; stockLevel: number }>;
  operatorInstruction?: string;
}): string {
  const productContext = input.products.length > 0
    ? `\nAvailable products:\n${input.products.map(p => `- ${p.name}: ${p.price.toLocaleString("vi-VN")} VND (stock: ${p.stockLevel})`).join("\n")}`
    : "";

  const instruction = input.operatorInstruction
    ? `\nOperator instruction: ${input.operatorInstruction}`
    : "";

  return `Customer message: "${input.customerMessage}"${productContext}${instruction}`;
}

function validateRiskLevel(level: string): ReplyPlan["riskLevel"] {
  const valid = ["low", "medium", "high", "blocked"];
  return valid.includes(level) ? (level as ReplyPlan["riskLevel"]) : "low";
}

function validateNextAction(action: string): ReplyPlan["nextBestAction"] {
  const valid = ["answer_question", "suggest_products", "ask_order_details", "handover_to_human"];
  return valid.includes(action) ? (action as ReplyPlan["nextBestAction"]) : "answer_question";
}
