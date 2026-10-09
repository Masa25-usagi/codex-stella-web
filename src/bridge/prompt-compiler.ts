export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }> | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CompilePromptOptions {
  messages: OpenAiMessage[];
  tools?: any[];
  instructions?: string;
}

export function compilePrompt(options: CompilePromptOptions): string {
  const { messages, tools, instructions } = options;
  const sections: string[] = [];

  // 1. Instructions / System prompt from Codex
  if (instructions && instructions.trim()) {
    sections.push(`## INSTRUCTIONS\n${instructions.trim()}`);
  }

  // 2. Tool system instructions (if tools are provided)
  if (tools && tools.length > 0) {
    let toolDoc = "## AVAILABLE TOOLS\nYou have access to the following tools:\n\n";
    for (const t of tools) {
      const fn = normalizeTool(t);
      if (!fn?.name) continue;
      const desc = fn.description ? fn.description.slice(0, 150) : "";
      toolDoc += `### Tool: \`${fn.name}\`\n`;
      if (desc) {
        toolDoc += `Description: ${desc}\n`;
      }
      if (fn.parameters) {
        toolDoc += `Parameters: ${JSON.stringify(compactParameters(fn.parameters))}\n`;
      }
      toolDoc += "\n";
    }

    toolDoc += `## TOOL CALLING INSTRUCTIONS
When you need to use a tool to accomplish a task, invoke it by emitting exact XML tags in this format:
<tool_call>
{"name": "tool_name", "arguments": {"param_key": "param_value"}}
</tool_call>

You may include reasoning or explanation before the <tool_call> tag.
`;
    sections.push(toolDoc);
  }

  // 2. Extract system messages
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length > 0) {
    const sysText = systemMessages
      .map((m) => formatContent(m.content))
      .filter(Boolean)
      .join("\n\n");
    if (sysText) {
      sections.push(`## SYSTEM INSTRUCTIONS\n${sysText}`);
    }
  }

  // 3. Conversation history
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length > 0) {
    const historyLines: string[] = [];
    for (const msg of nonSystem) {
      const content = formatContent(msg.content);

      if (msg.role === "user") {
        historyLines.push(`[User]:\n${content}`);
      } else if (msg.role === "assistant") {
        let text = content ? `[Assistant]:\n${content}` : "[Assistant]:";
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            text += `\n<tool_call>\n${JSON.stringify({
              name: tc.function.name,
              arguments: safeParseJson(tc.function.arguments),
            })}\n</tool_call>`;
          }
        }
        historyLines.push(text);
      } else if (msg.role === "tool") {
        const idInfo = msg.tool_call_id ? ` (ID: ${msg.tool_call_id})` : "";
        historyLines.push(`[Tool Result${idInfo}]:\n${content}`);
      }
    }

    sections.push(historyLines.join("\n\n"));
  }

  const full = sections.join("\n\n---\n\n");
  if (full.length <= MAX_STELLA_PROMPT_LENGTH) {
    return full;
  }

  // Preserve instructions & tools at the top, and latest user query at the bottom
  const prefix = full.slice(0, 8000);
  const suffix = full.slice(full.length - (MAX_STELLA_PROMPT_LENGTH - 8100));
  return `${prefix}\n\n[...中間コンテキスト省略...]\n\n${suffix}`;
}

function formatContent(content: OpenAiMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && part.text) {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function normalizeTool(t: any): { name?: string; description?: string; parameters?: unknown } | null {
  if (!t || typeof t !== "object") return null;
  if (t.function && typeof t.function === "object") {
    return {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    };
  }
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  };
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

const MAX_STELLA_PROMPT_LENGTH = 13500;

function compactParameters(params: any): any {
  if (!params || typeof params !== "object") return params;
  if (!params.properties || typeof params.properties !== "object") return params;

  const compactProps: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params.properties)) {
    if (val && typeof val === "object") {
      const v = val as Record<string, unknown>;
      compactProps[key] = {
        type: v.type || "string",
        ...(typeof v.description === "string" && v.description ? { description: v.description.slice(0, 80) } : {}),
      };
    } else {
      compactProps[key] = val;
    }
  }

  return {
    type: params.type || "object",
    properties: compactProps,
    ...(Array.isArray(params.required) ? { required: params.required } : {}),
  };
}
