import test from "node:test";
import assert from "node:assert/strict";
import { compilePrompt } from "../src/bridge/prompt-compiler.js";

test("compilePrompt formats simple user message", () => {
  const prompt = compilePrompt({
    messages: [{ role: "user", content: "Hello world" }],
  });
  assert.match(prompt, /\[User\]:\s*Hello world/);
});

test("compilePrompt includes system instructions", () => {
  const prompt = compilePrompt({
    messages: [
      { role: "system", content: "You are an expert coder." },
      { role: "user", content: "Write a function." },
    ],
  });
  assert.match(prompt, /## SYSTEM INSTRUCTIONS/);
  assert.match(prompt, /You are an expert coder\./);
  assert.match(prompt, /\[User\]:\s*Write a function\./);
});

test("compilePrompt documents nested and flat Codex tools", () => {
  const nested = compilePrompt({
    messages: [{ role: "user", content: "What is the weather?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for location",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
      },
    ],
  });
  assert.match(nested, /## AVAILABLE TOOLS/);
  assert.match(nested, /`get_weather`/);

  const flat = compilePrompt({
    messages: [{ role: "user", content: "Read a file" }],
    instructions: "Follow developer instructions.",
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  });
  assert.match(flat, /## INSTRUCTIONS/);
  assert.match(flat, /Follow developer instructions/);
  assert.match(flat, /`read_file`/);
});

test("compilePrompt documents tools when provided", () => {
  const prompt = compilePrompt({
    messages: [{ role: "user", content: "What is the weather?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for location",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
      },
    ],
  });

  assert.match(prompt, /## AVAILABLE TOOLS/);
  assert.match(prompt, /`get_weather`/);
  assert.match(prompt, /## TOOL CALLING INSTRUCTIONS/);
  assert.match(prompt, /<tool_call>/);
});

test("compilePrompt formats assistant messages and tool results", () => {
  const prompt = compilePrompt({
    messages: [
      { role: "user", content: "Check file" },
      {
        role: "assistant",
        content: "Checking file now",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "File contents here",
      },
    ],
  });

  assert.match(prompt, /\[User\]:\s*Check file/);
  assert.match(prompt, /\[Assistant\]:\s*Checking file now/);
  assert.match(prompt, /<tool_call>/);
  assert.match(prompt, /"name":\s*"read_file"/);
  assert.match(prompt, /\[Tool Result \(ID: call_123\)\]:\s*File contents here/);
});
