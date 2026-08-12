const assert = require("node:assert/strict");
const { test } = require("node:test");

const { xmlToJson } = require("../xml-json");

test("XML parses elements with attributes and text", () => {
  const result = xmlToJson('<root><item id="1">Mouse</item></root>');
  assert.deepEqual(result, { root: { item: { "@id": "1", "#text": "Mouse" } } });
});

test("XML converts repeated sibling tags to arrays", () => {
  const result = xmlToJson("<list><item>A</item><item>B</item><item>C</item></list>");
  assert.deepEqual(result, { list: { item: ["A", "B", "C"] } });
});

test("XML handles nested structures, self-closing tags, and mixed text", () => {
  const xml = "<config><db host=\"localhost\"><user>admin</user><pass>secret</pass></db><timeout>30</timeout><empty/></config>";
  const result = xmlToJson(xml);
  assert.deepEqual(result, {
    config: {
      db: {
        "@host": "localhost",
        user: "admin",
        pass: "secret"
      },
      timeout: "30",
      empty: ""
    }
  });
});

test("XML skips declarations, DOCTYPE, comments, and decodes entities", () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE root SYSTEM "x.dtd">\n<!-- comment -->\n<root><a>1 &lt; 2 &amp;&amp; 3</a><b>&#65;&#x42;</b></root>';
  const result = xmlToJson(xml);
  assert.deepEqual(result, { root: { a: "1 < 2 && 3", b: "AB" } });
});

test("XML supports CDATA blocks", () => {
  const result = xmlToJson("<root><code><![CDATA[if (a < b) { return \"x\"; }]]></code></root>");
  assert.deepEqual(result, { root: { code: 'if (a < b) { return "x"; }' } });
});

test("XML rejects malformed documents with a stable error code", () => {
  for (const xml of [
    "<root><a></root>",
    "<root><a></b></root>",
    "<root>unterminated",
    "<root attr=\"unterminated></root>"
  ]) {
    assert.throws(
      () => xmlToJson(xml),
      (error) => error.code === "XML_JSON_PARSE_FAILED" && /XML 解析失败/.test(error.message)
    );
  }
});

test("XML returns plain string for text-only elements and empty string for empty elements", () => {
  assert.deepEqual(xmlToJson("<root>plain</root>"), { root: "plain" });
  assert.deepEqual(xmlToJson("<root></root>"), { root: "" });
});

test("XML rejects empty input", () => {
  assert.throws(
    () => xmlToJson("   "),
    (error) => error.code === "XML_JSON_PARSE_FAILED"
  );
});
