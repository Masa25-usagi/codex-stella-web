import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { StellaClient } from "../stella/client.js";
import { resolveStellaModel } from "../stella/models.js";
import { compilePrompt } from "./prompt-compiler.js";
import { extractToolCalls } from "./tool-parser.js";

export interface ChatCompletionsRequest {
  model?: string;
  messages: any[];
  tools?: any[];
  stream?: boolean;
  temperature?: number;
  [key: string]: unknown;
}

export async function handleChatCompletions(
  reqBody: ChatCompletionsRequest,
  client: StellaClient,
  res: ServerResponse,
  signal?: AbortSignal
): Promise<void> {
  const modelName = reqBody.model || "stella-auto";
  const isStream = reqBody.stream ?? false;
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  // 1. Fetch available models (cached/fallback handled inside client/models)
  let availableModels: any[] = [];
  try {
    availableModels = await client.fetchAiModels();
  } catch {
    // offline or session issues will trigger on createChat
  }

  const resolved = resolveStellaModel(modelName, availableModels);
  const prompt = compilePrompt({
    messages: reqBody.messages || [],
    tools: reqBody.tools,
  });

  const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    res.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelName,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`
    );
  };

  if (isStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    writeChunk({ role: "assistant" });

    const hasTools = Array.isArray(reqBody.tools) && reqBody.tools.length > 0;
    let accumulatedText = "";

    await client.askOneTurn(
      prompt,
      resolved.stellaModelId,
      resolved.searchType,
      (chunk) => {
        if (chunk.type === "thinking" && chunk.thinking) {
          writeChunk({ reasoning_content: chunk.thinking });
        } else if (chunk.type === "text" && chunk.text) {
          accumulatedText += chunk.text;
          if (!hasTools) {
            writeChunk({ content: chunk.text });
          }
        }
      },
      signal
    );

    const { text, toolCalls } = extractToolCalls(accumulatedText);
    if (toolCalls.length > 0) {
      if (text) writeChunk({ content: text });
      writeChunk(
        {
          tool_calls: toolCalls.map((tc, i) => ({
            index: i,
            id: tc.id,
            type: "function",
            function: tc.function,
          })),
        },
        "tool_calls"
      );
    } else {
      if (hasTools && accumulatedText) writeChunk({ content: accumulatedText });
      writeChunk({}, "stop");
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    // Non-streaming response
    const fullOutput = await client.askOneTurn(
      prompt,
      resolved.stellaModelId,
      resolved.searchType,
      undefined,
      signal
    );

    const { text, toolCalls } = extractToolCalls(fullOutput);

    const responsePayload: Record<string, unknown> = {
      id: completionId,
      object: "chat.completion",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(fullOutput.length / 4),
        total_tokens: Math.ceil((prompt.length + fullOutput.length) / 4),
      },
    };

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(responsePayload));
  }
}
