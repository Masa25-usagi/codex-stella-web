import test from "node:test";
import assert from "node:assert/strict";
import { extractToolCalls } from "../src/bridge/tool-parser.js";

test("extractToolCalls parses XML <tool_call> tags", () => {
  const input = `
I will read the file for you.
<tool_call>
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
</tool_call>
`;

  const result = extractToolCalls(input);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    path: "src/index.ts",
  });
  assert.equal(result.text, "I will read the file for you.");
});

test("extractToolCalls parses multiple tool calls", () => {
  const input = `
<tool_call>
{"name": "func_a", "arguments": {"x": 1}}
</tool_call>
<tool_call>
{"name": "func_b", "arguments": {"y": 2}}
</tool_call>
`;

  const result = extractToolCalls(input);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, "func_a");
  assert.equal(result.toolCalls[1].function.name, "func_b");
});

test("extractToolCalls parses markdown ```json code block tool calls", () => {
  const input = `
Let's call the search function:
\`\`\`json
{
  "name": "search_code",
  "arguments": {
    "query": "hello"
  }
}
\`\`\`
`;

  const result = extractToolCalls(input);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "search_code");
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    query: "hello",
  });
});

test("extractToolCalls returns plain text when no tool calls exist", () => {
  const input = "Here is the code you requested:\n```javascript\nconsole.log(1);\n```";
  const result = extractToolCalls(input);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.text, input);
});
