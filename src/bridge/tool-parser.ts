import { randomUUID } from "node:crypto";

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolParseResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

/**
 * Parses tool calls out of a model's completion text.
 * Supports:
 * 1. <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * 2. ```tool_call\n{"name": "...", "arguments": {...}}\n```
 * 3. Standard JSON block with "name" and "arguments" / "parameters"
 */
export function extractToolCalls(rawText: string): ToolParseResult {
  const toolCalls: ParsedToolCall[] = [];
  let cleanText = rawText;

  // 1. Check for <tool_call> ... </tool_call>
  const xmlPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;

  while ((match = xmlPattern.exec(rawText)) !== null) {
    const rawJson = match[1].trim();
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed.name === "string") {
        const args = typeof parsed.arguments === "string"
          ? parsed.arguments
          : JSON.stringify(parsed.arguments || parsed.parameters || {});
        toolCalls.push({
          id: `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: args,
          },
        });
      }
    } catch {
      // Not valid JSON inside tag, skip
    }
  }

  if (toolCalls.length > 0) {
    cleanText = cleanText.replace(xmlPattern, "").trim();
    return { text: cleanText, toolCalls };
  }

  // 2. Check for ```tool_call or ```json tool call blocks
  const codeBlockPattern = /```(?:tool_call|json)\s*\n([\s\S]*?)\n```/gi;
  while ((match = codeBlockPattern.exec(rawText)) !== null) {
    const content = match[1].trim();
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.name === "string" && (parsed.arguments !== undefined || parsed.parameters !== undefined)) {
        const args = typeof parsed.arguments === "string"
          ? parsed.arguments
          : JSON.stringify(parsed.arguments || parsed.parameters || {});
        toolCalls.push({
          id: `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: args,
          },
        });
      }
    } catch {
      // not a tool call JSON
    }
  }

  if (toolCalls.length > 0) {
    cleanText = cleanText.replace(codeBlockPattern, "").trim();
  }

  return { text: cleanText, toolCalls };
}
