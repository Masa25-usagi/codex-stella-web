import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { StellaClient } from "../stella/client.js";
import { resolveStellaModel } from "../stella/models.js";
import { compilePrompt, type OpenAiMessage } from "./prompt-compiler.js";
import { extractToolCalls } from "./tool-parser.js";

function sse(res: ServerResponse, eventName: string, data: Record<string, unknown>): void {
  // Codex CLI's serde_json parser requires the "type" field inside the JSON payload
  const payload = {
    type: eventName,
    ...data,
  };
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function handleResponsesRequest(
  reqBody: any,
  client: StellaClient,
  res: ServerResponse,
  signal?: AbortSignal
): Promise<void> {
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const modelName = reqBody.model || "stella-auto";

  let availableModels: any[] = [];
  try {
    availableModels = await client.fetchAiModels();
  } catch {
    // ignore
  }

  const reasoningEffort =
    reqBody.reasoning_effort ||
    reqBody.reasoning?.effort ||
    reqBody.model_reasoning_effort;
  const resolved = resolveStellaModel(modelName, availableModels, reasoningEffort);

  // Parse prompt from input blocks or messages
  let messages: OpenAiMessage[] = reqBody.messages || [];

  if (!messages.length && reqBody.input !== undefined) {
    if (typeof reqBody.input === "string") {
      messages = [{ role: "user", content: reqBody.input }];
    } else if (Array.isArray(reqBody.input)) {
      messages = reqBody.input.map((item: any) => {
        if (item.type === "message") {
          return {
            role: item.role,
            content: item.content,
          };
        }
        if (item.type === "function_call") {
          return {
            role: "assistant",
            tool_calls: [
              {
                id: item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                  name: item.name,
                  arguments: item.arguments || "{}",
                },
              },
            ],
          };
        }
        if (item.type === "function_call_output") {
          return {
            role: "tool",
            tool_call_id: item.call_id,
            content: item.output || "",
          };
        }
        return {
          role: "user",
          content: typeof item === "string" ? item : JSON.stringify(item),
        };
      });
    }
  }

  const tools = reqBody.tools || reqBody.context?.tools || [];
  const instructions = reqBody.instructions || reqBody.context?.instructions;
  const prompt = compilePrompt({ messages, tools, instructions });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // 1. response.created
  sse(res, "response.created", {
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      model: modelName,
      output: [],
    },
  });

  const messageItemId = `msg_${randomUUID().replace(/-/g, "")}`;
  let outputIndex = 0;

  // 2. response.output_item.added (Assistant Message)
  sse(res, "response.output_item.added", {
    response_id: responseId,
    output_index: outputIndex,
    item: {
      id: messageItemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });

  // 3. response.content_part.added (canonical type is "output_text")
  sse(res, "response.content_part.added", {
    response_id: responseId,
    output_index: outputIndex,
    content_index: 0,
    part: {
      type: "output_text",
      text: "",
    },
  });

  let fullOutput = "";
  const hasTools = Array.isArray(tools) && tools.length > 0;

  const fail = (message: string) => {
    sse(res, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        status: "failed",
        error: { message, type: "stella_bridge_error" },
      },
    });
    res.end();
  };

  try {
    await client.askOneTurn(
      prompt,
      resolved.stellaModelId,
      resolved.searchType,
      (chunk) => {
        if (signal?.aborted) return;
        if (chunk.type === "thinking" && chunk.thinking) {
          sse(res, "response.reasoning_text.delta", {
            response_id: responseId,
            output_index: outputIndex,
            content_index: 0,
            delta: chunk.thinking,
          });
        } else if (chunk.type === "text" && chunk.text) {
          fullOutput += chunk.text;
          if (!hasTools) {
            sse(res, "response.output_text.delta", {
              response_id: responseId,
              output_index: outputIndex,
              content_index: 0,
              delta: chunk.text,
            });
          }
        }
      },
      signal
    );
  } catch (err) {
    if (signal?.aborted) {
      fail("client disconnected");
      return;
    }
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  if (signal?.aborted) {
    sse(res, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        status: "failed",
        error: { message: "client disconnected", type: "aborted" },
      },
    });
    res.end();
    return;
  }

  const { text: cleanText, toolCalls } = extractToolCalls(fullOutput);

  if (hasTools && cleanText) {
    sse(res, "response.output_text.delta", {
      response_id: responseId,
      output_index: outputIndex,
      content_index: 0,
      delta: cleanText,
    });
  }

  // 4. response.output_text.done
  sse(res, "response.output_text.done", {
    response_id: responseId,
    output_index: outputIndex,
    content_index: 0,
    text: cleanText,
  });

  const messageItem = {
    id: messageItemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: cleanText,
      },
    ],
  };

  // 5. response.output_item.done (Message)
  sse(res, "response.output_item.done", {
    response_id: responseId,
    output_index: outputIndex,
    item: messageItem,
  });

  const completedOutputItems: any[] = [messageItem];

  // 6. If tool calls detected, emit tool call items
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      outputIndex++;
      const toolItem = {
        id: tc.id,
        type: "function_call",
        status: "completed",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      };
      completedOutputItems.push(toolItem);

      sse(res, "response.output_item.added", {
        response_id: responseId,
        output_index: outputIndex,
        item: {
          id: tc.id,
          type: "function_call",
          status: "in_progress",
          call_id: tc.id,
          name: tc.function.name,
          arguments: "",
        },
      });

      sse(res, "response.function_call_arguments.delta", {
        response_id: responseId,
        output_index: outputIndex,
        call_id: tc.id,
        delta: tc.function.arguments,
      });

      sse(res, "response.function_call_arguments.done", {
        response_id: responseId,
        output_index: outputIndex,
        call_id: tc.id,
        arguments: tc.function.arguments,
      });

      sse(res, "response.output_item.done", {
        response_id: responseId,
        output_index: outputIndex,
        item: toolItem,
      });
    }
  }

  // 7. response.completed (output contains all completed items: message + tool calls)
  sse(res, "response.completed", {
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      model: modelName,
      output: completedOutputItems,
      usage: {
        total_tokens: Math.ceil((prompt.length + fullOutput.length) / 4),
        input_tokens: Math.ceil(prompt.length / 4),
        output_tokens: Math.ceil(fullOutput.length / 4),
      },
    },
  });

  res.end();
}
