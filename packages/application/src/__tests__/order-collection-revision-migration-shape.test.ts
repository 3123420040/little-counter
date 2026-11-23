import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(
  __dirname,
  "../../../../db/migrations/028_order_collection_revision_and_cursor_indexes.sql",
);

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

function withoutCommentsOrDollarBodies(value: string): string {
  return value
    .replace(/--.*$/gm, "")
    .replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/gi, "");
}

describe("DB-028 order collection revision/cursor migration contract", () => {
  it("only initializes the new revision table and never rewrites orders or finance", () => {
    const topLevel = withoutCommentsOrDollarBodies(sql());

    expect(topLevel).not.toMatch(/^\s*(update|delete|merge|truncate)\b/gim);
    const inserts = [...topLevel.matchAll(/^\s*insert\s+into\s+([^\s(]+)/gim)]
      .map((match) => match[1]?.toLowerCase());
    expect(inserts).toEqual(["app.order_collection_revisions"]);
    expect(topLevel.toLowerCase()).toContain("from app.stores");
    expect(topLevel).not.toMatch(/\b(customer_refund|3311|payment_events|journal_)\b/i);
  });

  it("defines durable per-store monotonic revision and idempotent mutation evidence", () => {
    const source = sql().toLowerCase();

    expect(source).toContain("create table if not exists app.order_collection_revisions");
    expect(source).toContain("primary key (merchant_id, store_id)");
    expect(source).toContain("create table if not exists app.order_collection_revision_events");
    expect(source).toContain("unique (merchant_id, store_id, mutation_id)");
    expect(source).toContain("bump_order_collection_revision");
    expect(source).toContain("for update");
    expect(source).toContain("revision = app.order_collection_revisions.revision + 1");
    expect(source).toContain("reject_collection_revision_event_mutation");
    expect(source).toContain("assert_collection_revision_event_pair");
    expect(source).toContain("revision advance lacks immutable mutation event");
    expect(source).toContain("deferrable initially deferred");
    expect(source).toContain("order_collection_revision_vector");
  });

  it("invalidates from order/effective-revision writes and indexes immutable cursor fields", () => {
    const source = sql().toLowerCase();

    expect(source).toContain("invalidate_order_collection");
    expect(source).toContain("current_setting('app.collection_mutation_id', true)");
    expect(source).toContain("order tenant scope is immutable");
    expect(source).toContain("after insert or update or delete on public.\"order\"");
    expect(source).toContain("after insert on app.order_commercial_revisions");
    expect(source).toContain("on public.\"order\"(merchant_id, store_id, created_at desc, id desc)");
    expect(source).toContain("lower(custom_display_id) text_pattern_ops");
    expect(source).not.toContain("customer_phone");
    expect(source).not.toContain("customer_email");
  });
});
