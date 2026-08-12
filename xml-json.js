// 轻量 XML -> JSON 转换器（零依赖）。
// 覆盖常见 XML：声明、DOCTYPE、注释、CDATA、自闭合标签、属性、嵌套、重复标签。
// 转换约定（xml2js 风格）：
//   - 元素 -> 对象；属性键加 "@" 前缀；文本存 "#text"（纯文本元素直接返回文本字符串）
//   - 同名重复子元素 -> 数组
// 解析失败抛 { code: "XML_JSON_PARSE_FAILED" }，避免把原始 XML 文本伪装成 JSON。
function parseError(message, position) {
  const error = new Error(`XML 解析失败：${message}${position != null ? `（位置 ${position}）` : ""}`);
  error.code = "XML_JSON_PARSE_FAILED";
  return error;
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const point = Number.parseInt(hex, 16);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const point = Number(dec);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : _m;
    })
    .replace(/&amp;/g, "&");
}

function parseXmlToJson(xml) {
  const source = String(xml || "").trim();
  if (!source) throw parseError("内容为空");

  // 去掉 XML 声明、DOCTYPE、注释（解析器只处理元素）。
  const cleaned = source
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  let index = 0;

  function skipWhitespace() {
    while (index < cleaned.length && /\s/.test(cleaned[index])) index += 1;
  }

  function expect(character) {
    if (cleaned[index] !== character) throw parseError(`期望 "${character}"`, index);
    index += 1;
  }

  function readName() {
    const start = index;
    while (index < cleaned.length && /[A-Za-z0-9_:.\-]/.test(cleaned[index])) index += 1;
    if (start === index) throw parseError("期望标签名", index);
    return cleaned.slice(start, index);
  }

  function readAttributeValue() {
    if (cleaned[index] !== '"' && cleaned[index] !== "'") throw parseError("期望属性值引号", index);
    const quote = cleaned[index];
    index += 1;
    const start = index;
    while (index < cleaned.length && cleaned[index] !== quote) index += 1;
    if (index >= cleaned.length) throw parseError("属性值未闭合", start);
    const value = decodeXmlEntities(cleaned.slice(start, index));
    index += 1;
    return value;
  }

  function readText() {
    const start = index;
    while (index < cleaned.length && cleaned[index] !== "<") index += 1;
    return decodeXmlEntities(cleaned.slice(start, index));
  }

  function parseElement() {
    expect("<");
    const name = readName();
    const attributes = Object.create(null);

    for (;;) {
      skipWhitespace();
      if (cleaned[index] === ">") {
        index += 1;
        break;
      }
      if (cleaned[index] === "/" && cleaned[index + 1] === ">") {
        index += 2;
        return { name, attributes, selfClosing: true };
      }
      const attrName = readName();
      skipWhitespace();
      expect("=");
      skipWhitespace();
      attributes[attrName] = readAttributeValue();
    }

    const children = [];
    let text = "";

    for (;;) {
      if (index >= cleaned.length) throw parseError(`标签 <${name}> 未闭合`, index);
      if (cleaned[index] === "<") {
        if (cleaned.startsWith("</", index)) {
          index += 2;
          const closeName = readName();
          skipWhitespace();
          expect(">");
          if (closeName !== name) throw parseError(`标签不匹配：期望 </${name}> 得到 </${closeName}>`, index);
          break;
        }
        if (cleaned.startsWith("<![CDATA[", index)) {
          const end = cleaned.indexOf("]]>", index);
          if (end < 0) throw parseError("CDATA 未闭合", index);
          text += cleaned.slice(index + 9, end);
          index = end + 3;
          continue;
        }
        children.push(parseElement());
      } else {
        text += readText();
      }
    }

    return { name, attributes, children, text };
  }

  skipWhitespace();
  const root = parseElement();
  skipWhitespace();
  if (index < cleaned.length) throw parseError("根元素之后存在多余内容", index);

  function convert(node) {
    const hasChildren = node.children && node.children.length > 0;
    const hasAttributes = Object.keys(node.attributes).length > 0;
    const text = String(node.text || "").trim();
    const hasText = text.length > 0;

    if (!hasChildren && !hasAttributes) return hasText ? text : "";
    if (!hasChildren) {
      const result = Object.create(null);
      for (const [key, value] of Object.entries(node.attributes)) result[`@${key}`] = value;
      if (hasText) result["#text"] = text;
      return result;
    }

    const result = Object.create(null);
    for (const child of node.children) {
      const key = child.name;
      const value = convert(child);
      if (key in result) {
        if (!Array.isArray(result[key])) result[key] = [result[key]];
        result[key].push(value);
      } else {
        result[key] = value;
      }
    }
    if (hasText) result["#text"] = text;
    for (const [attrKey, attrValue] of Object.entries(node.attributes)) result[`@${attrKey}`] = attrValue;
    return result;
  }

  return { [root.name]: convert(root) };
}

function xmlToJson(xml) {
  const parsed = parseXmlToJson(xml);
  // 解析器内部用 Object.create(null) 防 __proto__ 污染；出口转成普通对象，
  // 避免下游 deepStrictEqual / 序列化出现 prototype 差异。
  return JSON.parse(JSON.stringify(parsed));
}

module.exports = { parseXmlToJson, xmlToJson };
