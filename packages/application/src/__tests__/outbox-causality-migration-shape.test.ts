import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(
  __dirname,
  "../../../../db/migrations/027_outbox_causality_and_claim_fencing.sql",
);

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

function withoutCommentsOrDollarBodies(value: string): string {
  return value
    .replace(/--.*$/gm, "")
    .replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/gi, "");
}

describe("DB-027 outbox causality/claim migration contract", () => {
  it("does not rewrite, sequence or silently promote a legacy outbox row", () => {
    const topLevel = withoutCommentsOrDollarBodies(sql());

    expect(topLevel).not.toMatch(/^\s*(insert|update|delete|merge|truncate)\b/gim);
    expect(topLevel).not.toMatch(/\b(drop\s+(table|column|schema)|alter\s+column\s+.+\s+type)\b/i);
    expect(topLevel).not.toMatch(/update\s+outbox\.events[\s\S]*aggregate_sequence/i);
    expect(topLevel).not.toMatch(/update\s+outbox\.events[\s\S]*causality_quality/i);
  });

  it("adds exact sequence identity and quarantines ambiguous legacy rows", () => {
    const source = sql().toLowerCase();

    expect(source).toContain("create table if not exists outbox.aggregate_sequences");
    expect(source).toMatch(
      /foreign key\s*\(merchant_id,\s*store_id\)\s*references app\.stores\s*\(merchant_id,\s*id\)/,
    );
    for (const column of [
      "aggregate_sequence",
      "causality_quality",
      "source_occurred_at",
      "source_event_id",
      "claim_token",
      "claim_version",
      "claimed_at",
      "completed_at",
      "dead_lettered_at",
      "dead_letter_reason_code",
      "retry_policy_key",
    ]) {
      expect(source).toContain(`add column if not exists ${column}`);
    }
    expect(source).toContain("default 'legacy_ambiguous'");
    expect(source).toContain("create unique index if not exists outbox_events_exact_sequence_unique_idx");
    expect(source).toContain("create or replace view outbox.legacy_ambiguous_events");
    expect(source).toContain("enforce_new_event_causality");
    expect(source).toContain("aggregate sequence was not allocated in this scope");
    expect(source).toContain("exact outbox predecessor mismatch");
    expect(source).toContain("new exact outbox event must start pending");
    expect(source).toContain("or new.retry_policy_key is null");
    expect(source).toContain("or new.retry_policy_key = ''");
    expect(source).toContain("new.retry_policy_key is distinct from old.retry_policy_key");
    expect(source).toContain("reject_outbox_causality_mutation");
    expect(source).toContain("ambiguous legacy outbox event is quarantined");
    expect(source).toContain("terminal exact outbox event is immutable");
    expect(source).toContain("exact outbox claim transition is invalid");
  });

  it("defines atomic allocation and token/version compare-and-set claims", () => {
    const source = sql().toLowerCase();

    expect(source).toContain("allocate_aggregate_sequence");
    expect(source).toContain("claim_exact_events");
    expect(source).toContain("complete_exact_event_claim");
    expect(source).toContain("fail_exact_event_claim");
    expect(source).toContain("for update skip locked");
    expect(source).toContain("claim_token = p_claim_token");
    expect(source).toContain("claim_version = p_claim_version");
    expect(source).toContain("claimed_until >= clock_timestamp()");
    expect(source).toContain("failure fingerprint must be sha-256");
    expect(source).toContain("retry time must be in the future and within one hour");
    expect(source).toContain("interval '1 hour'");
    expect(source).toContain("causality_quality = 'exact'");
    expect(source).toContain("source_occurred_at");
    expect(source).toContain("predecessor.status = 'completed'");
    expect(source).toContain("create or replace view outbox.blocked_exact_events");
    expect(source).toContain("dead_predecessor");
  });

  it("rejects null failure evidence and null claim controls", () => {
    const source = sql().toLowerCase();

    expect(source.match(/new\.failure_fingerprint is null/g)).toHaveLength(2);
    expect(source).toMatch(/if\s+p_limit\s+is\s+null\s+or\s+p_limit\s*</);
    expect(source).toMatch(
      /if\s+p_lease_seconds\s+is\s+null\s+or\s+p_lease_seconds\s*</,
    );
    expect(source).toMatch(/if\s+p_dead_letter\s+is\s+null\s+then/);
  });

  it("keeps the outbox append-only by rejecting every delete path", () => {
    const source = sql().toLowerCase();

    expect(source).toContain("reject_outbox_event_delete");
    expect(source).toContain("before delete on outbox.events");
    expect(source).toContain("outbox events are append-only");
    expect(source).toMatch(/revoke\s+delete\s+on\s+outbox\.events\s+from\s+public/);
  });
});
