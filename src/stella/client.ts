import { STELLA_API_BASE } from "../config.js";
import { getValidIdToken } from "./auth.js";
import type {
  StellaAiModel,
  StellaChat,
  StellaMessageEvent,
  StellaSendMessageOptions,
  StellaStreamChunk,
} from "./types.js";

export class StellaClient {
  private apiBase: string;

  constructor(apiBase: string = STELLA_API_BASE) {
    this.apiBase = apiBase;
  }

  private async fetchWithAuth(
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const token = await getValidIdToken();
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Content-Type") && init.method && init.method !== "GET") {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.apiBase}${path}`;
    const response = await fetch(url, {
      ...init,
      headers,
    });

    return response;
  }

  /**
   * Fetch all AI models available to the authenticated Stella AI user.
   */
  async fetchAiModels(): Promise<StellaAiModel[]> {
    const res = await this.fetchWithAuth("/v1/ai-models");
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to fetch AI models (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    // data may be an array or { models: [...] } or { ai_models: [...] }
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.models)) return data.models;
    if (Array.isArray(data.ai_models)) return data.ai_models;
    return [];
  }

  /**
   * Create a new chat turn in Stella AI.
   */
  async createChat(textAiModelId?: string): Promise<StellaChat> {
    const body: Record<string, unknown> = {
      output_type: "text",
    };
    if (textAiModelId) {
      body.text_ai_model_id = textAiModelId;
    }

    const res = await this.fetchWithAuth("/v1/chats", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create chat (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const chat = data.chat || data;
    return {
      id: chat.id,
      title: chat.title,
      text_ai_model_id: chat.text_ai_model_id,
      created_at: chat.created_at,
    };
  }

  /**
   * Delete one or more chats by ID (to clean up temporary turns).
   */
  async deleteChats(chatIds: string[]): Promise<void> {
    if (chatIds.length === 0) return;
    try {
      await this.fetchWithAuth("/v1/chats/deletes", {
        method: "POST",
        body: JSON.stringify({ chat_ids: chatIds }),
      });
    } catch (err) {
      // Best-effort cleanup
      console.warn("[codex-stella-web] Warning: failed to delete chat:", err);
    }
  }

  /**
   * Send a message and stream the response line by line (NDJSON).
   */
  async sendMessageStream(
    chatId: string,
    options: StellaSendMessageOptions,
    onChunk: (chunk: StellaStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      search_type: options.search_type || "none",
      content: options.content,
      stream: true,
      enable_url_search: options.enable_url_search ?? false,
    };
    if (options.file_paths && options.file_paths.length > 0) {
      payload.file_paths = options.file_paths;
    }

    const res = await this.fetchWithAuth(`/v1/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to send message (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error("No response body from Stella AI stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    let lastContentLength = 0;
    let fullThinking = "";
    let lastThinkingLength = 0;
    let streamFinished = false;

    const processLine = (trimmed: string): boolean => {
      if (!trimmed) return false;
      try {
        const event = JSON.parse(trimmed) as StellaMessageEvent;
        const finished = Boolean(event.metadata?.is_finished);
        if (event.role !== "assistant") return finished;

        let thinkingText = "";
        let textText = event.content || "";

        if (Array.isArray(event.contents)) {
          let fromParts = "";
          for (const part of event.contents) {
            const kind = String(part.type || "text").toLowerCase();
            const partText = typeof part.text === "string" ? part.text : "";
            if (kind === "thinking" || kind === "thought") {
              thinkingText += partText;
            } else if (kind === "text" || kind === "output_text" || kind === "output") {
              fromParts += partText;
            }
          }
          if (fromParts) textText = fromParts;
        }

        // Also check for <think> or <thinking> tags if model emits them in content
        const thinkTags = [
          { open: "<think>", close: "</think>" },
          { open: "<thinking>", close: "</thinking>" },
        ];
        for (const tag of thinkTags) {
          if (textText.includes(tag.open)) {
            const start = textText.indexOf(tag.open);
            const end = textText.indexOf(tag.close);
            if (end !== -1) {
              thinkingText += textText.substring(start + tag.open.length, end);
              textText = textText.substring(0, start) + textText.substring(end + tag.close.length);
            } else {
              thinkingText += textText.substring(start + tag.open.length);
              textText = textText.substring(0, start);
            }
          }
        }

        // Stream thinking delta
        if (thinkingText.length > lastThinkingLength) {
          const delta = thinkingText.slice(lastThinkingLength);
          lastThinkingLength = thinkingText.length;
          fullThinking = thinkingText;
          onChunk({
            type: "thinking",
            thinking: delta,
            raw: event,
          });
        }

        // Stream text delta
        if (event.delta) {
          fullText += event.delta;
          onChunk({
            type: "text",
            text: event.delta,
            raw: event,
          });
        } else if (textText.length > lastContentLength) {
          const delta = textText.slice(lastContentLength);
          lastContentLength = textText.length;
          fullText = textText;
          onChunk({
            type: "text",
            text: delta,
            raw: event,
          });
        }

        return finished;
      } catch {
        // Ignore malformed JSON line
      }
      return false;
    };

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (processLine(line.trim())) {
            streamFinished = true;
            break;
          }
        }

        if (streamFinished) break;
      }

      // Process any remaining bytes in the buffer if stream ended without newline
      if (!streamFinished && buffer.trim()) {
        processLine(buffer.trim());
      }

      onChunk({
        type: "done",
        text: fullText,
        thinking: fullThinking,
      });

      return fullText;
    } catch (streamErr) {
      if (signal?.aborted) {
        return fullText;
      }
      onChunk({
        type: "error",
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      });
      throw streamErr;
    } finally {
      try {
        await reader.cancel().catch(() => {});
      } catch {
        // Ignore cancel errors
      }
      reader.releaseLock();
    }
  }

  /**
   * One-turn execution: creates a chat, sends message, streams, and cleans up chat.
   */
  async askOneTurn(
    content: string,
    modelId?: string,
    searchType: StellaSendMessageOptions["search_type"] = "none",
    onChunk?: (chunk: StellaStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const chat = await this.createChat(modelId);
    try {
      return await this.sendMessageStream(
        chat.id,
        { content, search_type: searchType },
        onChunk || (() => {}),
        signal
      );
    } finally {
      void this.deleteChats([chat.id]);
    }
  }
}
