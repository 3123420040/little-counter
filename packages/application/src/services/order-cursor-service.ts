import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  CursorClaimsV1Schema,
  CursorRefreshErrorSchema,
  ORDER_CURSOR_POLICY_V1,
  OrderCollectionRevisionVectorV1Schema,
  OrderCursorFiltersV1Schema,
  OrderCursorScopeV1Schema,
  OrderCursorTupleV1Schema,
  type CursorClaimsV1,
  type CursorRefreshError,
  type OrderCollectionRevisionVectorV1,
  type OrderCursorFiltersV1,
  type OrderCursorScopeV1,
  type OrderCursorTupleV1,
} from "@medusa-snus/contracts";

const CURSOR_TOKEN_PREFIX = "oc1";
const CURSOR_AUDIENCE = "order_list_v2" as const;
const CURSOR_AEAD_ALGORITHM = "aes-256-gcm";
const CURSOR_IV_BYTES = 12;
const CURSOR_AUTH_TAG_BYTES = 16;
const CURSOR_MAX_TOKEN_LENGTH = 8_192;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface OrderCursorKeyV1 {
  keyId: string;
  keyBase64Url: string;
}

export interface OrderCursorKeyringV1 {
  current: OrderCursorKeyV1;
  previous?: OrderCursorKeyV1;
}

export interface OrderCursorStoreWindowInputV1 {
  storeId: string;
  startInclusive: string;
  endExclusive: string;
}

export interface OrderCursorFiltersInputV1 {
  search?: string;
  statusMode?: "all" | "completed" | "other" | string;
  storeWindows: readonly OrderCursorStoreWindowInputV1[];
}

export interface CreateOrderCursorInputV1 {
  nowEpochSeconds: number;
  scope: OrderCursorScopeV1;
  filters: OrderCursorFiltersV1;
  highWatermark: OrderCursorTupleV1;
  position: OrderCursorTupleV1;
  storeRevisionVector: OrderCollectionRevisionVectorV1;
  asOf: string;
}

export interface VerifyOrderCursorExpectationV1 {
  nowEpochSeconds: number;
  scope: OrderCursorScopeV1;
  filters: OrderCursorFiltersV1;
  storeRevisionVector: OrderCollectionRevisionVectorV1;
}

export class OrderCursorError extends Error {
  readonly publicPayload: CursorRefreshError;

  constructor(readonly code: CursorRefreshError["code"]) {
    super("Order cursor cannot be continued; refresh from the first page");
    this.name = "OrderCursorError";
    this.publicPayload = CursorRefreshErrorSchema.parse({
      code,
      refreshFromStart: true,
    });
  }
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeOrderCursorFiltersV1(
  input: OrderCursorFiltersInputV1,
): OrderCursorFiltersV1 {
  const normalizedSearch = typeof input.search === "string"
    ? input.search.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
  const statusMode = String(input.statusMode || "all").trim().toLowerCase();
  const storeWindows = [...input.storeWindows]
    .map((window) => ({ ...window }))
    .sort((left, right) => left.storeId.localeCompare(right.storeId));
  return OrderCursorFiltersV1Schema.parse({
    searchMode: "order_identity",
    ...(normalizedSearch ? { search: normalizedSearch } : {}),
    statusMode,
    storeWindows,
  });
}

export function hashOrderCursorFiltersV1(filtersInput: OrderCursorFiltersV1): string {
  const filters = OrderCursorFiltersV1Schema.parse(filtersInput);
  return sha256Canonical({ schemaVersion: 1, filters });
}

export function hashStoreRevisionVectorV1(
  vectorInput: readonly OrderCollectionRevisionVectorV1[number][],
): string {
  const vector = normalizeStoreRevisionVectorV1(vectorInput);
  return sha256Canonical({ schemaVersion: 1, vector });
}

function normalizeStoreRevisionVectorV1(
  vectorInput: readonly OrderCollectionRevisionVectorV1[number][],
): OrderCollectionRevisionVectorV1 {
  return OrderCollectionRevisionVectorV1Schema.parse(
    [...vectorInput]
      .map((item) => ({ ...item }))
      .sort((left, right) => left.storeId.localeCompare(right.storeId)),
  );
}

function assertCursorStoreCoverage(
  scope: OrderCursorScopeV1,
  filters: OrderCursorFiltersV1,
  vector: OrderCollectionRevisionVectorV1,
): void {
  const filterStoreIds = filters.storeWindows.map((window) => window.storeId);
  const revisionStoreIds = vector.map((item) => item.storeId);
  if (
    filterStoreIds.length !== scope.storeIds.length
    || revisionStoreIds.length !== scope.storeIds.length
    || scope.storeIds.some((storeId, index) =>
      filterStoreIds[index] !== storeId || revisionStoreIds[index] !== storeId)
  ) {
    throw new Error("order cursor filter/revision stores must exactly match scope");
  }
}

function decodeKey(key: OrderCursorKeyV1): Buffer {
  if (
    typeof key.keyId !== "string"
    || key.keyId.length < 1
    || key.keyId.length > 128
    || !KEY_BASE64URL_PATTERN.test(key.keyBase64Url)
  ) {
    throw new Error("order cursor key configuration is invalid");
  }
  const decoded = decodeBase64Url(key.keyBase64Url);
  if (decoded.length !== 32) {
    throw new Error("order cursor key must contain exactly 32 bytes");
  }
  return decoded;
}

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("non-canonical base64url value");
  }
  return decoded;
}

function normalizedKeyring(keyring: OrderCursorKeyringV1): Array<{
  keyId: string;
  key: Buffer;
}> {
  const keys = [keyring.current, ...(keyring.previous ? [keyring.previous] : [])];
  if (keyring.previous && keyring.previous.keyId === keyring.current.keyId) {
    throw new Error("order cursor current and previous key IDs must differ");
  }
  return keys.map((entry) => ({ keyId: entry.keyId, key: decodeKey(entry) }));
}

export function validateOrderCursorKeyringV1(keyring: OrderCursorKeyringV1): void {
  normalizedKeyring(keyring);
}

function aad(keyId: string): Buffer {
  return Buffer.from(`orders.cursor.v1:${keyId}`, "utf8");
}

function encodeClaimsV1(
  claimsInput: Omit<CursorClaimsV1, "keyId">,
  keyring: OrderCursorKeyringV1,
): string {
  const keys = normalizedKeyring(keyring);
  const current = keys[0]!;
  const claims = CursorClaimsV1Schema.parse({
    ...claimsInput,
    keyId: current.keyId,
  });
  const iv = randomBytes(CURSOR_IV_BYTES);
  const cipher = createCipheriv(CURSOR_AEAD_ALGORITHM, current.key, iv, {
    authTagLength: CURSOR_AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad(current.keyId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(claims), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    CURSOR_TOKEN_PREFIX,
    Buffer.from(current.keyId, "utf8").toString("base64url"),
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

function invalidCursor(): never {
  throw new OrderCursorError("invalid_cursor");
}

function decodeTokenClaimsV1(
  token: string,
  keyring: OrderCursorKeyringV1,
): CursorClaimsV1 {
  if (
    typeof token !== "string"
    || token.length < 1
    || token.length > CURSOR_MAX_TOKEN_LENGTH
  ) {
    return invalidCursor();
  }
  const segments = token.split(".");
  if (
    segments.length !== 5
    || segments[0] !== CURSOR_TOKEN_PREFIX
    || segments.slice(1).some((segment) => !segment || !BASE64URL_PATTERN.test(segment))
  ) {
    return invalidCursor();
  }

  try {
    const tokenKeyId = decodeBase64Url(segments[1]!).toString("utf8");
    const key = normalizedKeyring(keyring).find((entry) => entry.keyId === tokenKeyId);
    if (!key) return invalidCursor();
    const iv = decodeBase64Url(segments[2]!);
    const ciphertext = decodeBase64Url(segments[3]!);
    const tag = decodeBase64Url(segments[4]!);
    if (
      iv.length !== CURSOR_IV_BYTES
      || ciphertext.length < 1
      || tag.length !== CURSOR_AUTH_TAG_BYTES
    ) {
      return invalidCursor();
    }
    const decipher = createDecipheriv(CURSOR_AEAD_ALGORITHM, key.key, iv, {
      authTagLength: CURSOR_AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(tokenKeyId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const claims = CursorClaimsV1Schema.parse(JSON.parse(plaintext.toString("utf8")));
    if (claims.keyId !== tokenKeyId) return invalidCursor();
    return claims;
  } catch (error) {
    if (error instanceof OrderCursorError) throw error;
    return invalidCursor();
  }
}

function scopesEqual(left: OrderCursorScopeV1, right: OrderCursorScopeV1): boolean {
  return left.merchantId === right.merchantId
    && left.storeIds.length === right.storeIds.length
    && left.storeIds.every((storeId, index) => storeId === right.storeIds[index]);
}

function tupleIsStrictlyOlder(
  candidate: OrderCursorTupleV1,
  current: OrderCursorTupleV1,
): boolean {
  const candidateTime = Date.parse(candidate.createdAt);
  const currentTime = Date.parse(current.createdAt);
  return candidateTime < currentTime
    || (candidateTime === currentTime && candidate.id < current.id);
}

export function createOrderCursorV1(
  input: CreateOrderCursorInputV1,
  keyring: OrderCursorKeyringV1,
): string {
  const scope = OrderCursorScopeV1Schema.parse(input.scope);
  const filters = OrderCursorFiltersV1Schema.parse(input.filters);
  const storeRevisionVector = normalizeStoreRevisionVectorV1(input.storeRevisionVector);
  assertCursorStoreCoverage(scope, filters, storeRevisionVector);
  return encodeClaimsV1({
    schemaVersion: 1,
    audience: CURSOR_AUDIENCE,
    issuedAtEpochSeconds: input.nowEpochSeconds,
    expiresAtEpochSeconds: input.nowEpochSeconds + ORDER_CURSOR_POLICY_V1.ttlSeconds,
    sort: ORDER_CURSOR_POLICY_V1.sort,
    scope,
    filtersHash: hashOrderCursorFiltersV1(filters),
    highWatermark: OrderCursorTupleV1Schema.parse(input.highWatermark),
    position: OrderCursorTupleV1Schema.parse(input.position),
    storeRevisionVectorHash: hashStoreRevisionVectorV1(storeRevisionVector),
    asOf: input.asOf,
  }, keyring);
}

export function advanceOrderCursorV1(
  claimsInput: CursorClaimsV1,
  positionInput: OrderCursorTupleV1,
  keyring: OrderCursorKeyringV1,
): string {
  const claims = CursorClaimsV1Schema.parse(claimsInput);
  const position = OrderCursorTupleV1Schema.parse(positionInput);
  if (!tupleIsStrictlyOlder(position, claims.position)) {
    throw new Error("next order cursor position must be strictly older");
  }
  const { keyId: _keyId, ...unsignedClaims } = claims;
  return encodeClaimsV1({ ...unsignedClaims, position }, keyring);
}

export function verifyOrderCursorV1(
  token: string,
  expectationInput: VerifyOrderCursorExpectationV1,
  keyring: OrderCursorKeyringV1,
): CursorClaimsV1 {
  const claims = decodeTokenClaimsV1(token, keyring);
  const scope = OrderCursorScopeV1Schema.parse(expectationInput.scope);
  const filters = OrderCursorFiltersV1Schema.parse(expectationInput.filters);
  const storeRevisionVector = normalizeStoreRevisionVectorV1(
    expectationInput.storeRevisionVector,
  );
  assertCursorStoreCoverage(scope, filters, storeRevisionVector);
  const filtersHash = hashOrderCursorFiltersV1(filters);
  const storeRevisionVectorHash = hashStoreRevisionVectorV1(storeRevisionVector);
  if (
    !Number.isSafeInteger(expectationInput.nowEpochSeconds)
    || expectationInput.nowEpochSeconds < claims.issuedAtEpochSeconds
  ) {
    return invalidCursor();
  }
  if (expectationInput.nowEpochSeconds >= claims.expiresAtEpochSeconds) {
    throw new OrderCursorError("expired_cursor");
  }
  if (
    !scopesEqual(claims.scope, scope)
    || claims.filtersHash !== filtersHash
  ) {
    return invalidCursor();
  }
  if (claims.storeRevisionVectorHash !== storeRevisionVectorHash) {
    throw new OrderCursorError("stale_cursor");
  }
  return claims;
}
