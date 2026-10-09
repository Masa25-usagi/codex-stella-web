export interface StellaSession {
  idToken: string;
  refreshToken: string;
  expiresAt: number; // unix timestamp in ms
  userId?: string;
  userEmail?: string;
}

export type StellaSearchType = "none" | "speed" | "pro" | "deep" | "deep_inference";

export interface StellaAiModel {
  id: string; // ULID in Stella backend
  name: string;
  model?: string; // Canonical slug e.g. "gpt-5.6-terra", "global.anthropic.claude-sonnet-5"
  model_type?: string; // "text" | "image"
  description?: string;
  vendor?: string;
  is_default?: boolean;
  type?: string;
  priority?: number;
  credit_cost?: number;
  capabilities?: string[];
}

export interface StellaChat {
  id: string;
  title?: string;
  text_ai_model_id?: string;
  created_at?: string;
}

export interface StellaSendMessageOptions {
  content: string;
  search_type?: StellaSearchType;
  stream?: boolean;
  enable_url_search?: boolean;
  file_paths?: string[];
}

export interface StellaMessageEvent {
  id?: string;
  role: "user" | "assistant" | "system";
  content?: string;
  contents?: Array<{
    type?: string;
    text?: string;
    [key: string]: unknown;
  }>;
  delta?: string;
  metadata?: {
    is_finished?: boolean;
    search_type?: string;
    tokens_used?: number;
    [key: string]: unknown;
  };
}

export interface StellaStreamChunk {
  type: "text" | "thinking" | "done" | "error";
  text?: string;
  thinking?: string;
  raw?: StellaMessageEvent;
  error?: string;
}
