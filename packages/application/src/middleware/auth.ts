import { createHmac, timingSafeEqual } from "node:crypto";
import { hash as bcryptHash, compare as bcryptCompare } from "bcrypt";

// ═══════════════════════════════════════════════════════
// Auth Middleware — JWT + Role Guard + Password Hashing
// Owned by: packages/application
// ═══════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────

export type Role = "staff" | "manager" | "accountant" | "owner";
export type AuthState = "authenticated" | "password_change_required";

export interface JwtPayload {
  operatorId: string;
  role: string;
  displayName: string;
  organizationId: string;
  sessionVersion?: number;
  authState?: AuthState;
  impersonationSessionId?: string;
  actualOperatorId?: string;
  effectiveOperatorId?: string;
  iat: number;
  exp: number;
}

// ── JWT Helpers ────────────────────────────────────────

const JWT_SECRET_PLACEHOLDER = "change-me-to-a-random-256-bit-secret-min-32-chars";
const TOKEN_EXPIRY_H = 8;

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim() || "";
  if (!secret || secret.length < 32 || secret === JWT_SECRET_PLACEHOLDER) {
    throw new Error("JWT_SECRET must be set to a non-placeholder value of at least 32 characters");
  }
  return secret;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString("base64url");
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString();
}

export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + TOKEN_EXPIRY_H * 3600 };

  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encHeader}.${encPayload}`;
  const signature = createHmac("sha256", jwtSecret()).update(signatureInput).digest("base64url");

  return `${encHeader}.${encPayload}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [encHeader, encPayload, signature] = parts;
    const expectedSig = createHmac("sha256", jwtSecret()).update(`${encHeader}.${encPayload}`).digest("base64url");
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);
    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

    const payload = JSON.parse(base64UrlDecode(encPayload)) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Role Guard ─────────────────────────────────────────

const ROLE_GRANTS: Record<Role, Role[]> = {
  staff: ["staff"],
  manager: ["staff", "manager"],
  accountant: ["staff", "accountant"],
  owner: ["staff", "manager", "accountant", "owner"],
};

export function requireRole(payload: JwtPayload, minRole: Role): boolean {
  return (ROLE_GRANTS[payload.role as Role] || []).includes(minRole);
}

export function authMiddleware(req: { headers: Record<string, string> }): JwtPayload | null {
  const auth = req.headers?.["authorization"] || req.headers?.["Authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!token) return null;
  return verifyJwt(token);
}

// ── Password Hash (bcrypt, salt=12) ────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcryptHash(password, 12);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return bcryptCompare(password, stored);
}

// ── Guards ─────────────────────────────────────────────

export class UnauthorizedError extends Error {
  public code = "unauthorized";
  public statusCode = 401;
  constructor(message = "Authentication required") { super(message); }
}

export class ForbiddenError extends Error {
  public code = "forbidden";
  public statusCode = 403;
  constructor(message = "Insufficient permissions") { super(message); }
}

export function authenticate(req: { headers: Record<string, string> }): JwtPayload {
  const payload = authMiddleware(req);
  if (!payload) throw new UnauthorizedError();
  return payload;
}

export function authorize(payload: JwtPayload, minRole: Role): void {
  if (!requireRole(payload, minRole)) {
    throw new ForbiddenError(`This action requires at least ${minRole} role`);
  }
}

export function createRouteGuard(minRole?: Role) {
  return (req: { headers: Record<string, string> }) => {
    const payload = authenticate(req);
    if (minRole) authorize(payload, minRole);
    return payload;
  };
}
