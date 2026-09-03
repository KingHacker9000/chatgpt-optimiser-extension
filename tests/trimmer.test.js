const test = require("node:test");
const assert = require("node:assert/strict");

global.window = global;
require("../src/trimmer.js");
const { trimConversation } = global.__CGO_TRIMMER__;

function linearConversation(turns) {
  const mapping = {};
  mapping.root = { parent: null, children: [] };
  let parent = "root";

  for (let i = 0; i < turns; i += 1) {
    const user = `u${i}`;
    const thinking = `t${i}`;
    const assistant = `a${i}`;
    mapping[user] = { parent, children: [thinking], message: { author: { role: "user" }, content: { parts: [`user ${i}`] } } };
    mapping[thinking] = { parent: user, children: [assistant], message: { author: { role: "thinking" }, content: { parts: [`hidden ${i}`] } } };
    mapping[assistant] = { parent: thinking, children: [], message: { author: { role: "assistant" }, content: { parts: [`assistant ${i}`] } } };
    mapping[parent].children = [user];
    parent = assistant;
  }
  return { mapping, current_node: parent, root: "root" };
}

test("keeps the requested number of visible user/assistant turns", () => {
  const data = linearConversation(6); // 12 visible messages
  const result = trimConversation(data, 4);
  assert.equal(result.changed, true);
  assert.equal(result.visibleTotal, 12);
  assert.equal(result.visibleKept, 4);
  assert.equal(result.archive.length, 8);
  assert.deepEqual(Object.keys(result.mapping), ["root", "u4", "t4", "a4", "u5", "t5", "a5"]);
});

test("preserves hidden nodes attached to kept visible messages", () => {
  const data = linearConversation(3);
  const result = trimConversation(data, 2);
  assert.ok(result.mapping.t2);
  assert.equal(result.mapping.u2.parent, "root");
  assert.equal(result.mapping.t2.parent, "u2");
  assert.equal(result.mapping.a2.parent, "t2");
});

test("returns unchanged data when the thread is already below the limit", () => {
  const data = linearConversation(2);
  const result = trimConversation(data, 10);
  assert.equal(result.changed, false);
  assert.equal(result.archive.length, 0);
  assert.equal(result.visibleTotal, 4);
});

test("archives only visible text, not hidden thinking/tool content", () => {
  const data = linearConversation(3);
  const result = trimConversation(data, 2);
  assert.equal(result.archive.length, 4);
  assert.equal(result.archive.some((item) => item.text.includes("hidden")), false);
});

test("fails safely for malformed conversation payloads", () => {
  assert.equal(trimConversation({}, 10), null);
  assert.equal(trimConversation({ mapping: {}, current_node: "missing" }, 10), null);
});
