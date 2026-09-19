const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { File } = require("node:buffer");
const { test } = require("node:test");

// The seam is the page's file input / convert controls and HTTP responses.
// Load every real script listed by index.html, in order. Only browser services
// are represented here: no application function (including error hooks) is
// invented, replaced or copied out of app.js. Real layout is tested in Electron.
async function pageHarness(convert) {
  const publicDir = path.join(__dirname, "..", "public");
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const all = [];
  function element(tag = "div") {
    let content = "";
    const node = { tag, id: "", className: "", value: "", hidden: false, disabled: false,
      children: [], dataset: {}, style: {}, listeners: new Map(), attributes: {},
      get options() { return this.children.filter(child => child.tag === "option"); },
      get textContent() { return content + this.children.map(child => child.textContent).join(""); },
      set textContent(value) { content = String(value); this.children = []; },
      append(...children) { this.children.push(...children); if (tag === "select" && !this.value) this.value = children[0]?.value || ""; },
      replaceChildren(...children) { content = ""; this.children = []; if (tag === "select") this.value = ""; this.append(...children); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); },
      async dispatch(name) { await Promise.all((this.listeners.get(name) || []).map(callback => callback({ target: this, preventDefault() {} }))); },
      focus() {}, contains(other) { return this === other || this.children.some(child => child.contains(other)); },
      querySelector(selector) { return this.children.find(child => matches(child, selector)) || null; }
    };
    node.classList = { add(value) { node.className += ` ${value}`; }, remove(value) { node.className = node.className.split(/\s+/).filter(item => item !== value).join(" "); },
      toggle(value, enabled) { this.remove(value); if (enabled) this.add(value); } };
    return node;
  }
  function matches(node, selector) {
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    if (selector.startsWith(".")) return node.className.split(/\s+/).includes(selector.slice(1));
    const data = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
    if (data) { const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return key in node.dataset && (data[2] === undefined || node.dataset[key] === data[2]); }
    const option = selector.match(/^option\[value="([^"]*)"\]$/);
    return Boolean(option && node.tag === "option" && node.value === option[1]);
  }
  function parseElement(tag, attributes) {
    const node = element(tag);
    for (const [, key, value = ""] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (["hidden", "disabled", "selected"].includes(key)) node[key] = true;
      else if (key === "class") node.className = value;
      else if (key.startsWith("data-")) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      else node[key] = value;
    }
    return node;
  }
  for (const [, tag, attributes = ""] of html.matchAll(/<([a-z][\w-]*)(\s[^>]*?)?>/g)) all.push(parseElement(tag, attributes));
  const find = selector => all.find(node => matches(node, selector)) || null;
  for (const [, attributes, body] of html.matchAll(/<select\s([^>]+)>([\s\S]*?)<\/select>/g)) {
    const id = attributes.match(/id="([^"]+)"/)?.[1];
    if (!id) continue;
    const select = find(`#${id}`);
    select.append(...[...body.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)].map(([, attrs, text]) => Object.assign(parseElement("option", attrs), { textContent: text })));
    select.value = select.options.find(option => option.selected)?.value ?? select.options[0]?.value ?? "";
  }
  const document = { querySelector: find, querySelectorAll: selector => all.filter(node => matches(node, selector)),
    createElement: element, documentElement: element("html"), body: element("body"), addEventListener() {}, contains: () => true };
  const timers = new Set(), streams = [], requests = [], logs = [];
  const storage = new Map();
  let ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body) });
  const context = vm.createContext({ document, navigator: { language: "en-US" }, crypto: webcrypto, FormData, File, AbortController,
    console, URL, setTimeout, clearTimeout,
    setInterval(callback) { const timer = { callback }; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {},
    EventSource: class { constructor(url) { this.url = url; this.closed = false; streams.push(this); } close() { this.closed = true; } },
    flyingMouseFormat: { getAppVersion: async () => "0.7.6", rendererReady: async () => ready(),
      log: async (level, message) => logs.push({ level, message }) },
    fetch: async (url, options = {}) => {
      if (url === "/api/capabilities") return response({ tools: {}, toolDetails: {}, groups: {} });
      if (url === "/api/targets") return response({ category: "pdf", targets: ["docx", "html"] });
      if (url === "/api/convert") {
        const file = options.body.get("file"); requests.push(file.name);
        const result = await convert(file, requests.length);
        return response(result.body, result.status);
      }
      throw new Error(`Unexpected HTTP request: ${url}`);
    }
  });
  context.window = context;
  for (const [, file] of html.matchAll(/<script\s+src="\/([^"]+)"/g)) vm.runInContext(fs.readFileSync(path.join(publicDir, file), "utf8"), context, { filename: file });
  await initialized;
  assert.equal(logs.some(entry => entry.level === "error"), false, JSON.stringify(logs));
  return { find, timers, streams, requests, logs,
    async select(names) {
      find("#fileInput").files = names.map(name => new File(["fixture"], name));
      await find("#fileInput").dispatch("change");
      for (let attempt = 0; attempt < 20 && find("#targetSelect").disabled; attempt++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(find("#targetSelect").disabled, false, find("#statusBox").textContent);
    },
    convert: () => find("#convertButton").dispatch("click")
  };
}

for (const failure of ["PDF_STRUCTURE_RESOURCE_LIMIT", "OCR_LOW_CONFIDENCE", "Network connection lost"]) {
test(`${failure} keeps its reason, continues the queue and restores usable controls`, async () => {
  const page = await pageHarness((_file, index) => {
    if (index !== 1) return { status: 200, body: { fileName: "second.docx", downloadUrl: "/downloads/second" } };
    if (failure === "Network connection lost") throw new Error(failure);
    return { status: 422, body: { errorCode: failure, error: "The document could not be converted." } };
  });
  await page.select(["first.pdf", "second.pdf"]);
  await page.convert();
  assert.deepEqual(page.requests, ["first.pdf", "second.pdf"]);
  const rows = page.find("#batchList").children;
  assert.match(rows[0].className, /error/);
  assert.ok(rows[0].textContent.includes(failure));
  assert.match(rows[1].className, /success/);
  assert.match(page.find("#statusBox").textContent, /1 succeeded, 1 failed/);
  for (const id of ["convertButton", "clearButton", "fileInput", "targetSelect"]) assert.equal(page.find(`#${id}`).disabled, false, id);
  assert.equal(page.timers.size, 0);
  assert.equal(page.streams.every(stream => stream.closed), true);
  assert.equal(page.find("#downloadButton").download, "second.docx");
  await page.select(["retry.pdf"]);
  await page.convert();
  assert.deepEqual(page.requests, ["first.pdf", "second.pdf", "retry.pdf"]);
});
}

for (const failAt of ["0%", "100%"]) {
test(`a progress display error at ${failAt} still releases controls, clocks and progress streams`, async () => {
  const page = await pageHarness(() => ({ status: 200, body: { fileName: "one.docx", downloadUrl: "/downloads/one" } }));
  await page.select(["one.pdf"]);
  // Browser/DOM failure at the page boundary, not a stub of setProgress or any
  // application helper. A finally boundary must run even when rendering fails.
  let displayFailure = true;
  Object.defineProperty(page.find("#progressFill").style, "width", { set(value) {
    if (displayFailure && value === failAt) { displayFailure = false; throw new Error("Progress DOM unavailable"); }
  } });
  await assert.rejects(page.convert(), /Progress DOM unavailable/);
  for (const id of ["convertButton", "clearButton", "fileInput", "targetSelect"]) assert.equal(page.find(`#${id}`).disabled, false, id);
  assert.equal(page.timers.size, 0);
  assert.equal(page.streams.every(stream => stream.closed), true);
  await page.find("#clearButton").dispatch("click");
  assert.equal(page.find("#batchList").children.length, 0, "selection can be cleared after the display exception");
});
}
