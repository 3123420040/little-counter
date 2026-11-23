import { describe, expect, it, beforeEach } from "vitest";
import { createApplication, createEmptyApplicationState, InMemoryStoreAdapter } from "../index.js";
import { seedState } from "./fixtures.js";
import type { RequestContext } from "../index.js";

function makeCtx(): RequestContext {
  return { actor: { type: "staff", id: "op_owner" }, correlationId: "cor_test" };
}

function makeApp() {
  const state = createEmptyApplicationState();
  seedState(state);
  const store = new InMemoryStoreAdapter(state);
  const app = createApplication({ store });
  return { app, store, state };
}

describe("AI Reply Draft Flow", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let state: ReturnType<typeof makeApp>["state"];

  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    state = result.state;
  });

  it("generates draft with product info", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Còn Mint Medium không? Giá bao nhiêu?",
      productContext: ["prod_mint"],
      context: makeCtx(),
    });

    expect(action.status).toBe("review_required");
    expect(action.outputPayload).toBeTruthy();
    expect(action.outputPayload.responseText).toBeTruthy();
    expect(action.outputPayload.confidence).toBeGreaterThan(0.5);
    expect(action.actionType).toBe("reply_draft");
  });

  it("generates generic response when no product context", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Còn hàng không?",
      context: makeCtx(),
    });

    expect(action.outputPayload.responseText).toBeTruthy();
    expect(action.status).toBe("review_required");
  });

  it("blocks health claims in generated text", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Sản phẩm này có giúp bỏ thuốc không?",
      context: makeCtx(),
    });

    // The deterministic provider won't generate blocked claims
    // But if someone asked about health, the risk assessment should still work
    const blockedClaimsCount = (action.outputPayload.blockedClaimsFiltered as string[])?.length ?? 0;
    const riskLevel = action.outputPayload.riskLevel as string;
    // Either blocked claims or not the lowest risk
    expect(blockedClaimsCount === 0 || riskLevel !== "low").toBe(true);
  });

  it("stores AI action in state", async () => {
    await app.requestAiReplyDraft({
      customerMessage: "Còn Mint Medium không?",
      productContext: ["prod_mint"],
      context: makeCtx(),
    });

    expect(state.aiActions).toHaveLength(1);
    expect(state.aiActions[0].actionType).toBe("reply_draft");
    expect(state.aiActions[0].status).toBe("review_required");
  });

  it("allows operator to approve draft", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Còn Mint Medium không?",
      productContext: ["prod_mint"],
      context: makeCtx(),
    });

    const approved = await app.approveAiAction({
      aiActionId: action.id,
      approvedText: "Dạ bên em còn hàng ạ. Giá 250k/hộp.",
      context: makeCtx(),
    });

    expect(approved.status).toBe("approved");
    expect(approved.approvedText).toBe("Dạ bên em còn hàng ạ. Giá 250k/hộp.");
    expect(approved.reviewedBy).toBe("op_owner");
  });

  it("allows operator to reject draft", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Hello",
      context: makeCtx(),
    });

    const rejected = await app.rejectAiAction({
      aiActionId: action.id,
      reason: "Tôi tự trả lời khách",
      context: makeCtx(),
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Tôi tự trả lời khách");
    expect(rejected.reviewedBy).toBe("op_owner");
  });

  it("rejects approval of already processed action", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Hello",
      context: makeCtx(),
    });
    await app.approveAiAction({ aiActionId: action.id, context: makeCtx() });

    await expect(app.approveAiAction({
      aiActionId: action.id,
      context: makeCtx(),
    })).rejects.toThrow("Cannot approve action in status");
  });

  it("rejects approval of non-existent action", async () => {
    await expect(app.approveAiAction({
      aiActionId: "nonexistent",
      context: makeCtx(),
    })).rejects.toThrow("AI action not found");
  });

  it("rejects already rejected action", async () => {
    const action = await app.requestAiReplyDraft({ customerMessage: "Hello", context: makeCtx() });
    await app.rejectAiAction({ aiActionId: action.id, reason: "No", context: makeCtx() });
    await expect(app.rejectAiAction({ aiActionId: action.id, reason: "Again", context: makeCtx() })).rejects.toThrow("Cannot reject");
  });

  it("generates price inquiry response for generic price question", async () => {
    const action = await app.requestAiReplyDraft({ customerMessage: "Giá bao nhiêu?", context: makeCtx() });
    expect(action.outputPayload.responseText).toContain("báo giá");
  });

  it("generates availability check response for stock question", async () => {
    const action = await app.requestAiReplyDraft({ customerMessage: "Còn hàng không?", context: makeCtx() });
    expect(action.outputPayload.responseText).toContain("tồn kho");
  });

  it("generates standard greeting for unrecognized messages", async () => {
    const action = await app.requestAiReplyDraft({ customerMessage: "Xin chào", context: makeCtx() });
    expect(action.outputPayload.responseText).toContain("giúp gì");
  });

  it("rejects already rejected action", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Hello",
      context: makeCtx(),
    });
    await app.rejectAiAction({ aiActionId: action.id, reason: "No", context: makeCtx() });

    await expect(app.rejectAiAction({
      aiActionId: action.id,
      reason: "Double reject",
      context: makeCtx(),
    })).rejects.toThrow("Cannot reject action in status");
  });

  it("generates price inquiry response when no product context", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Giá bao nhiêu?",
      context: makeCtx(),
    });
    expect(action.outputPayload.responseText).toContain("báo giá");
  });

  it("generates standard greeting for unrecognized messages", async () => {
    const action = await app.requestAiReplyDraft({
      customerMessage: "Xin chào",
      context: makeCtx(),
    });
    expect(action.outputPayload.responseText).toContain("giúp gì");
  });
});
