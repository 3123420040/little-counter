export interface MedusaRequest {
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
}

export interface MedusaResponse {
  status: (code: number) => MedusaResponse;
  json: (body: unknown) => void;
  send: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}
