const katex = require("katex");

function renderMath(text, displayMode) {
  try {
    // Native MathML works offline: no CDN, executable HTML, font download, or
    // document-supplied macro dictionary is required.
    return katex.renderToString(text, { displayMode, output: "mathml", throwOnError: true, trust: false, strict: "error", maxExpand: 1000 });
  } catch (cause) {
    const error = new Error(`Markdown 公式无法转换：${cause.message}`);
    error.code = "MARKDOWN_MATH_UNSUPPORTED";
    error.messages = { zhCN: error.message, enUS: `Markdown mathematics could not be converted: ${cause.message}` };
    error.cause = cause;
    throw error;
  }
}

function markdownExtensions() {
  return [{
    name: "displayMath", level: "block",
    start(source) { const index = source.search(/\$\$|\\\[/); return index < 0 ? undefined : index; },
    tokenizer(source) {
      const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:[ \t]*\n|$)/.exec(source);
      if (match) return { type: "displayMath", raw: match[0], text: (match[1] || match[2]).trim() };
    },
    renderer(token) { return `${renderMath(token.text, true)}\n`; }
  }, {
    name: "inlineMath", level: "inline",
    start(source) { const index = source.search(/\$|\\\(/); return index < 0 ? undefined : index; },
    tokenizer(source) {
      const match = /^(?:\$(?!\$)([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)|\\\(([^\n]+?)\\\))/.exec(source);
      if (match) return { type: "inlineMath", raw: match[0], text: match[1] || match[2] };
    },
    renderer(token) { return renderMath(token.text, false); }
  }, {
    name: "highlight", level: "inline",
    start(source) { const index = source.indexOf("=="); return index < 0 ? undefined : index; },
    tokenizer(source) {
      const match = /^==(?=\S)([^\n]+?)==/.exec(source);
      if (match) return { type: "highlight", raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) { return `<mark>${this.parser.parseInline(token.tokens)}</mark>`; }
  }];
}

module.exports = { markdownExtensions, renderMath };
