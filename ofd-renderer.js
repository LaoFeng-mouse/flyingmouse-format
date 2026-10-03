/**
 * Local maintained derivative of @miconvert/ofd-to-pdf 0.2.3 (Apache-2.0).
 * Upstream: Antigravity / MiConvert. Modified by LaoFeng on 2026-10-02.
 * See third-party/ofd-to-pdf/NOTICE.md and LICENSE for provenance and changes.
 */
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  convert: () => convert,
  default: () => index_default,
  parse: () => parse,
  inspect: () => inspect
});
module.exports = __toCommonJS(index_exports);
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
const { throwIfCanceled, cancellationError } = require('./conversion-cancellation');
async function checkpoint(signal) {
  throwIfCanceled(signal);
  await new Promise(resolve => setImmediate(resolve));
  throwIfCanceled(signal);
}

// src/parser/unzip.ts
var import_jszip = __toESM(require("jszip"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
const OFD_LIMITS = Object.freeze({ input:128*1024*1024, entry:64*1024*1024,
  expanded:256*1024*1024, entries:10000, xml:8*1024*1024, pages:500,
  objects:100000, nodes:250000, depth:64, imagePixels:50000000, totalImagePixels:100000000 });
function ofdError(code, message) { return Object.assign(new Error(message), {code}); }
function requireCondition(ok, code, message) { if (!ok) throw ofdError(code,message); }
async function extractOfd(input, options = {}) {
  await checkpoint(options.signal);
  let data;
  if (typeof input === 'string') {
    const info = fs.statSync(input);
    requireCondition(info.isFile() && info.size <= OFD_LIMITS.input, 'OFD_RESOURCE_LIMIT', 'OFD 文件超出读取上限。');
    data = fs.readFileSync(input);
  } else data = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  requireCondition(data && data.byteLength <= OFD_LIMITS.input, 'OFD_RESOURCE_LIMIT', 'OFD 文件超出读取上限。');
  let zip;
  try { zip = await import_jszip.default.loadAsync(data); }
  catch { throw ofdError('OFD_INVALID_ARCHIVE','OFD 压缩包无法读取。'); }
  const entries = Object.values(zip.files);
  requireCondition(entries.length <= OFD_LIMITS.entries, 'OFD_RESOURCE_LIMIT', 'OFD 文件条目过多。');
  let total = 0;
  const archive = new Map();
  for (const entry of entries) {
    await checkpoint(options.signal);
    if (entry.dir) continue;
    const name = entry.unsafeOriginalName || entry.name;
    const normalized = resolvePath('',name);
    requireCondition(normalized === name.replace(/\\/g,'/') && !archive.has(normalized.toLowerCase()), 'OFD_INVALID_ARCHIVE', 'OFD 压缩包含重复或不安全路径。');
    const size = entry._data?.uncompressedSize;
    const compressed = entry._data?.compressedSize;
    requireCondition(Number.isSafeInteger(size) && size >= 0 && size <= OFD_LIMITS.entry && Number.isSafeInteger(compressed) && size <= Math.max(1024*1024,compressed*1000), 'OFD_RESOURCE_LIMIT', 'OFD 解压条目超出安全上限。');
    total += size;
    requireCondition(total <= OFD_LIMITS.expanded, 'OFD_RESOURCE_LIMIT', 'OFD 解压总量超出安全上限。');
    // Count emitted bytes too: do not trust the ZIP central directory alone.
    const chunks=[]; let emitted=0;
    await new Promise((resolve,reject)=>{
      const stream=entry.nodeStream('nodebuffer');
      const abort=()=>stream.destroy(cancellationError());
      const cleanup=()=>options.signal?.removeEventListener('abort',abort);
      options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted)abort();
      stream.on('data',chunk=>{ if(options.signal?.aborted){abort();return;}emitted+=chunk.length; if(emitted>size || emitted>OFD_LIMITS.entry) stream.destroy(ofdError('OFD_RESOURCE_LIMIT','OFD 解压大小不一致。')); else chunks.push(chunk); });
      stream.on('error',error=>{cleanup();reject(error);}); stream.on('end',()=>{cleanup();resolve();});
    });
    requireCondition(emitted===size,'OFD_INVALID_ARCHIVE','OFD 解压大小不一致。');
    archive.set(normalized.toLowerCase(),Buffer.concat(chunks,emitted));
  }
  return archive;
}
function readTextFile(archive,filePath) {
  const bytes=readBinaryFile(archive,filePath);
  if(!bytes) return null;
  requireCondition(bytes.length <= OFD_LIMITS.xml,'OFD_RESOURCE_LIMIT','OFD XML 文件过大。');
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { throw ofdError('OFD_INVALID_XML','OFD XML 编码无效。'); }
}
function readBinaryFile(archive,filePath) { return archive.get(resolvePath('',filePath).toLowerCase()) || null; }

// src/parser/ofd-xml.ts
var import_fast_xml_parser = require("fast-xml-parser");

// src/parser/page-parser.ts
function getVal(node, ...names) {
  if (!node) return void 0;
  for (const name of names) {
    if (node[name] !== void 0) return node[name];
    if (node[`ofd:${name}`] !== void 0) return node[`ofd:${name}`];
  }
  return void 0;
}
function ensureArray(val) {
  if (val === void 0 || val === null) return [];
  return Array.isArray(val) ? val : [val];
}
function parseColor(node){
  if(!node)return undefined;
  onlyAttrs(node,['Value']);onlyChildren(node,[]);
  let values=String(node['@_Value']||'').trim().split(/\s+/).map(Number);
  requireCondition([1,3].includes(values.length)&&values.every(n=>Number.isFinite(n)&&n>=0&&n<=255),'OFD_UNSUPPORTED_CONTENT','OFD 色彩格式暂不支持。');
  if(values.length===1)values=[values[0],values[0],values[0]];
  return {value:values.join(' ')};
}
function parseColorStr(str) {
  if (!str) return void 0;
  return { value: str };
}
function parseCTM(ctmStr) {
  if (!ctmStr) return void 0;
  const parts = ctmStr.trim().split(/\s+/).map(Number);
  if (parts.length < 6) return void 0;
  return {
    a: parts[0],
    b: parts[1],
    c: parts[2],
    d: parts[3],
    e: parts[4],
    f: parts[5]
  };
}
function parseAbbreviatedData(data) {
  if (!data) return [];
  const commands = [];
  const tokens = data.trim().split(/\s+/);
  const arity = { M: 2, L: 2, B: 6, Q: 4, A: 7, C: 0, S: 2 };
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i];
    requireCondition(Object.hasOwn(arity,cmd), 'OFD_UNSUPPORTED_CONTENT', 'OFD 路径指令暂不支持。');
    requireCondition(i + arity[cmd] < tokens.length && tokens.slice(i+1,i+1+arity[cmd]).every(value => Number.isFinite(Number(value))), 'OFD_INVALID_XML', 'OFD 路径坐标不完整。');
    switch (cmd) {
      case "S":
      case "M":
        commands.push({
          type: "M",
          x: Number(tokens[i + 1]),
          y: Number(tokens[i + 2])
        });
        i += 3;
        break;
      case "L":
        commands.push({
          type: "L",
          x: Number(tokens[i + 1]),
          y: Number(tokens[i + 2])
        });
        i += 3;
        break;
      case "B":
        commands.push({
          type: "B",
          x1: Number(tokens[i + 1]),
          y1: Number(tokens[i + 2]),
          x2: Number(tokens[i + 3]),
          y2: Number(tokens[i + 4]),
          x: Number(tokens[i + 5]),
          y: Number(tokens[i + 6])
        });
        i += 7;
        break;
      case "Q":
        commands.push({
          type: "Q",
          x1: Number(tokens[i + 1]),
          y1: Number(tokens[i + 2]),
          x: Number(tokens[i + 3]),
          y: Number(tokens[i + 4])
        });
        i += 5;
        break;
      case "A":
        commands.push({
          type: "A",
          rx: Number(tokens[i + 1]),
          ry: Number(tokens[i + 2]),
          angle: Number(tokens[i + 3]),
          large: tokens[i + 4] === "1",
          sweep: tokens[i + 5] === "1",
          x: Number(tokens[i + 6]),
          y: Number(tokens[i + 7])
        });
        i += 8;
        break;
      case "C":
        commands.push({ type: "C" });
        i += 1;
        break;
      default:
        i += 1;
        break;
    }
  }
  return commands;
}
function parseDeltaValues(deltaStr){
  if(!deltaStr)return [];
  const tokens=String(deltaStr).trim().split(/\s+/);const result=[];
  for(let i=0;i<tokens.length;){
    if(tokens[i]==='g'){
      const count=Number(tokens[i+1]),value=Number(tokens[i+2]);
      requireCondition(Number.isSafeInteger(count)&&count>=0&&count<=OFD_LIMITS.objects&&result.length+count<=OFD_LIMITS.objects,'OFD_RESOURCE_LIMIT','OFD 字符位置数据过大。');
      requireCondition(Number.isFinite(value),'OFD_INVALID_XML','OFD 字符位置数据无效。');
      for(let j=0;j<count;j++)result.push(value);i+=3;
    }else{const value=Number(tokens[i++]);requireCondition(Number.isFinite(value),'OFD_INVALID_XML','OFD 字符位置数据无效。');result.push(value);}
  }
  return result;
}
function parseTextCodes(objNode) {
  const textCodeNodes = ensureArray(getVal(objNode, "TextCode"));
  const codes = [];
  for (const tc of textCodeNodes) {
    const text = typeof tc === "string" ? tc : tc?.["#text"] ?? "";
    if (!text) continue;
    codes.push({
      x: tc?.["@_X"] !== void 0 ? Number(tc["@_X"]) : void 0,
      y: tc?.["@_Y"] !== void 0 ? Number(tc["@_Y"]) : void 0,
      deltaX: parseDeltaValues(tc?.["@_DeltaX"]),
      deltaY: parseDeltaValues(tc?.["@_DeltaY"]),
      text: String(text)
    });
  }
  return codes;
}
function parseTextObject(obj) {
  const id = obj?.["@_ID"] ?? "";
  const boundary = parseBox(obj?.["@_Boundary"]);
  const font = obj?.["@_Font"] ?? "";
  const size = Number(obj?.["@_Size"] ?? 10);
  const fillColorNode = getVal(obj, "FillColor");
  const strokeColorNode = getVal(obj, "StrokeColor");
  return {
    type: "text",
    id,
    boundary,
    font,
    size,
    fillColor: fillColorNode ? parseColor(fillColorNode) ?? parseColorStr(fillColorNode?.["@_Value"]) : void 0,
    strokeColor: strokeColorNode ? parseColor(strokeColorNode) ?? parseColorStr(strokeColorNode?.["@_Value"]) : void 0,
    weight: obj?.["@_Weight"] ? Number(obj["@_Weight"]) : void 0,
    italic: obj?.["@_Italic"] === "true",
    ctm: parseCTM(obj?.["@_CTM"]),
    textCodes: parseTextCodes(obj),
    alpha: obj?.["@_Alpha"] != null ? Number(obj["@_Alpha"]) : void 0
  };
}
function parsePathObject(obj) {
  const id = obj?.["@_ID"] ?? "";
  const boundary = parseBox(obj?.["@_Boundary"]);
  const abbreviatedDataNode = getVal(obj, "AbbreviatedData");
  const abbreviatedData = typeof abbreviatedDataNode === "string" ? abbreviatedDataNode : abbreviatedDataNode?.["#text"] ?? "";
  const fillColorNode = getVal(obj, "FillColor");
  const strokeColorNode = getVal(obj, "StrokeColor");
  const hasFill = obj?.["@_Fill"] === "true" || (obj?.["@_Fill"] !== "false" && fillColorNode !== void 0);
  const hasStroke = obj?.["@_Stroke"] !== "false";
  const dashPatternStr = obj?.["@_DashPattern"];
  let dashPattern;
  if (dashPatternStr) {
    dashPattern = String(dashPatternStr).trim().split(/\s+/).map(Number);
  }
  const joinStr = obj?.["@_Join"];
  let join;
  if (joinStr === "Round") join = "round";
  else if (joinStr === "Bevel") join = "bevel";
  else if (joinStr === "Miter") join = "miter";
  const capStr = obj?.["@_Cap"];
  let cap;
  if (capStr === "Round") cap = "round";
  else if (capStr === "Square") cap = "square";
  else if (capStr === "Butt") cap = "butt";
  return {
    type: "path",
    id,
    boundary,
    abbreviatedData,
    commands: parseAbbreviatedData(abbreviatedData),
    fillColor: fillColorNode ? parseColor(fillColorNode) ?? parseColorStr(fillColorNode?.["@_Value"]) : void 0,
    strokeColor: strokeColorNode ? parseColor(strokeColorNode) ?? parseColorStr(strokeColorNode?.["@_Value"]) : void 0,
    lineWidth: obj?.["@_LineWidth"] ? Number(obj["@_LineWidth"]) : void 0,
    ctm: parseCTM(obj?.["@_CTM"]),
    fill: hasFill,
    stroke: hasStroke,
    dashPattern,
    dashOffset: obj?.["@_DashOffset"] != null ? Number(obj["@_DashOffset"]) : void 0,
    join,
    cap,
    miterLimit: obj?.["@_MiterLimit"] != null ? Number(obj["@_MiterLimit"]) : void 0,
    alpha: obj?.["@_Alpha"] != null ? Number(obj["@_Alpha"]) : void 0
  };
}
function parseImageObject(obj) {
  const id = obj?.["@_ID"] ?? "";
  const boundary = parseBox(obj?.["@_Boundary"]);
  const resourceId = obj?.["@_ResourceID"] ?? "";
  return {
    type: "image",
    id,
    boundary,
    resourceId,
    ctm: parseCTM(obj?.["@_CTM"]),
    alpha: obj?.["@_Alpha"] != null ? Number(obj["@_Alpha"]) : void 0
  };
}
const LAYER_ORDER = Object.freeze({ Background: 1, Body: 3, Foreground: 5 });
function layerType(value, fallback='Body') {
  const type=value||fallback;
  requireCondition(Object.hasOwn(LAYER_ORDER,type),'OFD_INVALID_XML','OFD 图层类型无效。');
  return type;
}
function resolveDrawParam(id,drawParams,ancestors=[]){
  if(!id)return {};
  requireCondition(ancestors.length<64&&!ancestors.includes(id),'OFD_INVALID_XML','OFD 绘制参数存在循环或过深继承。');
  const node=drawParams.get(id);
  requireCondition(node,'OFD_MISSING_RESOURCE','OFD 绘制参数资源缺失。');
  onlyAttrs(node,['ID','Relative','LineWidth','Join','Cap','DashOffset','DashPattern','MiterLimit']);
  onlyChildren(node,['FillColor','StrokeColor']);
  const resolved={...resolveDrawParam(node['@_Relative'],drawParams,[...ancestors,id])};
  for(const [key,value] of Object.entries(node))if((key.startsWith('@_')&&!['@_ID','@_Relative'].includes(key))||['FillColor','StrokeColor'].includes(key))resolved[key]=value;
  for(const name of ['FillColor','StrokeColor'])if(resolved[name])parseColor(resolved[name]);
  return resolved;
}
function parseLayer(layerNode,drawParams=new Map(),inherited={}){
  onlyAttrs(layerNode,['ID','Type','DrawParam']);
  const style={...inherited,...resolveDrawParam(layerNode['@_DrawParam'],drawParams)};
  const objects=[];
  for(const child of layerNode.$children||[]){
    const name=child.name;let node=child.node;
    if(name==='PageBlock'){objects.push(...parseLayer(node,drawParams,style).objects);continue;}
    requireCondition(['TextObject','PathObject','ImageObject'].includes(name),'OFD_UNSUPPORTED_CONTENT','OFD 含暂不支持的 '+name+'，已停止导出以免遗漏。');
    const base=['ID','Boundary','CTM','Alpha','Visible','DrawParam'];
    onlyAttrs(node,base.concat(name==='TextObject'?['Font','Size','Fill','Stroke','HScale','Weight','Italic','ReadDirection','CharDirection']:name==='PathObject'?['Fill','Stroke','LineWidth','DashPattern','DashOffset','Join','Cap','MiterLimit','Rule']:['ResourceID','Interpolate']));
    onlyChildren(node,name==='TextObject'?['TextCode','FillColor']:name==='PathObject'?['AbbreviatedData','FillColor','StrokeColor']:[]);
    if(name==='TextObject')requireCondition((!node['@_Weight']||Number(node['@_Weight'])===400)&&(!node['@_Italic']||node['@_Italic']==='false')&&(!node['@_ReadDirection']||Number(node['@_ReadDirection'])===0)&&(!node['@_CharDirection']||Number(node['@_CharDirection'])===0),'OFD_UNSUPPORTED_CONTENT','OFD 特殊字重、斜体或文字方向暂不支持。');
    if(name==='ImageObject')requireCondition(!node['@_Interpolate']||node['@_Interpolate']==='false','OFD_UNSUPPORTED_CONTENT','OFD 图像插值暂不支持。');
    node={...style,...resolveDrawParam(node['@_DrawParam'],drawParams),...node};
    if(node['@_Visible']==='false')continue;
    if(name==='TextObject')requireCondition(node['@_Stroke']!=='true'&&node['@_Fill']!=='false'&&(!node['@_HScale']||Number(node['@_HScale'])===1),'OFD_UNSUPPORTED_CONTENT','OFD 文字描边或变形暂不支持。');
    if(name==='PathObject')requireCondition(!node['@_Rule']||node['@_Rule']==='NonZero','OFD_UNSUPPORTED_CONTENT','OFD 路径填充规则暂不支持。');
    const obj=name==='TextObject'?parseTextObject(node):name==='PathObject'?parsePathObject(node):parseImageObject(node);
    if(node['@_CTM'])requireCondition(String(node['@_CTM']).trim().split(/\s+/).length===6&&obj.ctm&&Object.values(obj.ctm).every(Number.isFinite),'OFD_INVALID_XML','OFD 对象变换无效。');
    if(obj.alpha!==undefined)requireCondition(Number.isFinite(obj.alpha)&&obj.alpha>=0&&obj.alpha<=255,'OFD_INVALID_XML','OFD 透明度无效。');
    if(obj.type!=='path'&&obj.ctm)requireCondition(obj.ctm.b===0&&obj.ctm.c===0&&obj.ctm.a>0&&obj.ctm.d>0&&(obj.type!=='text'||obj.ctm.a===obj.ctm.d),'OFD_UNSUPPORTED_CONTENT','OFD 文字或图像旋转/镜像/非等比文字暂不支持。');
    if(obj.type==='text'){
      requireCondition(Number.isFinite(obj.size)&&obj.size>0&&obj.size<=1000,'OFD_INVALID_XML','OFD 字号无效。');
      for(const tc of getVal(node,'TextCode')?[].concat(getVal(node,'TextCode')):[]){onlyAttrs(tc,['X','Y','DeltaX','DeltaY']);onlyChildren(tc,[]);}
      for(const tc of obj.textCodes)requireCondition((tc.x===undefined||Number.isFinite(tc.x))&&(tc.y===undefined||Number.isFinite(tc.y)),'OFD_INVALID_XML','OFD 文字坐标无效。');
    }
    if(obj.type==='path'){
      requireCondition(obj.commands.length>0&&obj.commands.every(cmd=>Object.values(cmd).every(value=>typeof value!=='number'||Number.isFinite(value))),'OFD_INVALID_XML','OFD 路径指令无效。');
      requireCondition(!/[^MLBQACS\s\d.eE+\-]/.test(obj.abbreviatedData),'OFD_UNSUPPORTED_CONTENT','OFD 路径指令暂不支持。');
      if(obj.ctm&&obj.commands.some(cmd=>cmd.type==='A'))requireCondition(obj.ctm.a===1&&obj.ctm.b===0&&obj.ctm.c===0&&obj.ctm.d===1,'OFD_UNSUPPORTED_CONTENT','OFD 变换圆弧暂不支持。');
      if(obj.dashPattern)requireCondition(obj.dashPattern.length%2===0&&obj.dashPattern.every(n=>Number.isFinite(n)&&n>=0),'OFD_INVALID_XML','OFD 虚线样式无效。');
      if(obj.fill&&!obj.fillColor)obj.fillColor={value:'0 0 0'};
    }
    objects.push(obj);
    requireCondition(objects.length<=OFD_LIMITS.objects,'OFD_RESOURCE_LIMIT','OFD 页面对象过多。');
  }
  return {id:layerNode['@_ID'],type:layerType(layerNode['@_Type']),objects};
}
function parsePage(pageXml,pageId,pageIndex,defaultArea,drawParams){
  const root=getVal(pageXml,'Page');
  requireCondition(root&&!Array.isArray(root),'OFD_INVALID_XML','OFD 页 XML 无效。');
  onlyChildren(root,['Area','Template','PageRes','Content']);
  const areaNode=getVal(root,'Area');
  if(areaNode)onlyChildren(areaNode,['PhysicalBox']);
  const area=areaNode?parseBox(xmlText(getVal(areaNode,'PhysicalBox'))):defaultArea;
  requireCondition(area&&area.width>0&&area.height>0&&area.width<=2000&&area.height<=2000&&area.x===0&&area.y===0,'OFD_UNSUPPORTED_CONTENT','OFD 页面大小或偏移暂不支持。');
  const content=getVal(root,'Content');onlyChildren(content,['Layer']);
  const layers=ensureArray(getVal(content,'Layer')).map(node=>parseLayer(node,drawParams));
  layers.sort((a,b)=>LAYER_ORDER[a.type]-LAYER_ORDER[b.type]);
  const templates=ensureArray(getVal(root,'Template')).map(t=>({id:t['@_TemplateID'],zOrder:t['@_ZOrder']}));
  for(const tpl of templates)requireCondition(tpl.id&&(!tpl.zOrder||Object.hasOwn(LAYER_ORDER,tpl.zOrder)),'OFD_INVALID_XML','OFD 模板引用无效。');
  return {id:pageId,index:pageIndex,area,layers,templates,pageResources:ensureArray(getVal(root,'PageRes')).map(xmlText)};
}

// src/parser/ofd-xml.ts

const orderedXmlParser=new import_fast_xml_parser.XMLParser({preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:'@_',parseTagValue:false,parseAttributeValue:false,trimValues:false,processEntities:true,allowBooleanAttributes:false});
const OFD_NAMESPACE='http://www.ofdspec.org/2016';
const xmlParser={parse(xml){
  requireCondition(!/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml),'OFD_INVALID_XML','OFD XML 不允许外部实体或 DTD。');
  requireCondition(import_fast_xml_parser.XMLValidator.validate(xml)===true,'OFD_INVALID_XML','OFD XML 结构无效。');
  let count=0;
  function normalize(entries,inherited,depth){
    requireCondition(depth<=OFD_LIMITS.depth,'OFD_RESOURCE_LIMIT','OFD XML 嵌套过深。');
    const parent=Object.create(null); parent.$children=[];
    for(const entry of entries){
      if(Object.hasOwn(entry,'#text')){parent['#text']=(parent['#text']||'')+String(entry['#text']);continue;}
      const qualified=Object.keys(entry).find(key=>key!==':@');
      if(!qualified || qualified.startsWith('?') || qualified.startsWith('#'))continue;
      requireCondition(++count<=OFD_LIMITS.nodes,'OFD_RESOURCE_LIMIT','OFD XML 节点过多。');
      const bindings={...inherited}; const attrs=entry[':@']||{};
      for(const [key,value] of Object.entries(attrs)){
        if(key==='@_xmlns')bindings['']=value;
        else if(key.startsWith('@_xmlns:'))bindings[key.slice(8)]=value;
      }
      const pieces=qualified.split(':');const prefix=pieces.length===2?pieces[0]:'';const local=pieces.at(-1);
      requireCondition(pieces.length<=2 && bindings[prefix]===OFD_NAMESPACE,'OFD_INVALID_XML','OFD XML 命名空间不受支持。');
      const node=normalize(entry[qualified]||[],bindings,depth+1);
      for(const [key,value] of Object.entries(attrs)){
        if(key.startsWith('@_xmlns'))continue;
        requireCondition(!key.slice(2).includes(':'),'OFD_UNSUPPORTED_CONTENT','OFD 扩展属性暂不支持。');
        node[key]=value;
      }
      parent.$children.push({name:local,node});
      if(parent[local]===undefined) parent[local]=node;
      else if(Array.isArray(parent[local]))parent[local].push(node);
      else parent[local]=[parent[local],node];
    }
    return parent;
  }
  return normalize(orderedXmlParser.parse(xml),{},0);
}};
function xmlText(value){return typeof value==='string'?value:value?.['#text']?.trim()||'';}
function onlyChildren(node,allowed){for(const child of node?.$children||[]) requireCondition(allowed.includes(child.name),'OFD_UNSUPPORTED_CONTENT','OFD 含暂不支持的 '+child.name+' 内容，已停止导出以免遗漏。');}
function onlyAttrs(node,allowed){for(const key of Object.keys(node||{}))if(key.startsWith('@_'))requireCondition(allowed.includes(key.slice(2)),'OFD_UNSUPPORTED_CONTENT','OFD 含暂不支持的绘制属性，已停止导出以免遗漏。');}
function parseBox(boxStr){
  requireCondition(typeof boxStr==='string','OFD_INVALID_XML','OFD 页面或对象缺少边界。');
  const parts=boxStr.trim().split(/\s+/).map(Number);
  requireCondition(parts.length===4 && parts.every(Number.isFinite) && parts[2]>=0 && parts[3]>=0 && parts.every(n=>Math.abs(n)<=10000),'OFD_INVALID_XML','OFD 页面或对象边界无效。');
  return {x:parts[0],y:parts[1],width:parts[2],height:parts[3]};
}
function resolvePath(basePath,relativePath){
  requireCondition(typeof relativePath==='string' && relativePath.trim().length>0 && !/[\x00-\x1f:*?<>|]/.test(relativePath) && !relativePath.startsWith('//') && !relativePath.startsWith('\\\\'), 'OFD_INVALID_ARCHIVE','OFD 资源路径无效。');
  const rel=relativePath.replace(/\\/g,'/');
  const parts=(rel.startsWith('/')?[]:basePath.split('/').slice(0,-1)).concat(rel.split('/'));
  const result=[];
  for(const part of parts){if(part==='..'){requireCondition(result.length>0,'OFD_INVALID_ARCHIVE','OFD 资源路径越界。');result.pop();}else if(part!=='.'&&part!=='')result.push(part);}
  return result.join('/');
}
function getXmlVal(node, ...names) {
  if (!node) return void 0;
  for (const name of names) {
    if (node[name] !== void 0) return node[name];
    if (node[`ofd:${name}`] !== void 0) return node[`ofd:${name}`];
  }
  return void 0;
}
function ensureArray2(val) {
  if (val === void 0 || val === null) return [];
  return Array.isArray(val) ? val : [val];
}
async function parseOfdXml(archive,options={}){
  await checkpoint(options.signal);
  const rootText=readTextFile(archive,'OFD.xml');
  requireCondition(rootText,'OFD_INVALID_XML','OFD.xml 缺失。');
  const root=getXmlVal(xmlParser.parse(rootText),'OFD');
  const bodies=ensureArray(getXmlVal(root,'DocBody'));
  requireCondition(bodies.length===1,'OFD_UNSUPPORTED_CONTENT','OFD 多文档容器暂不支持。');
  requireCondition(!getXmlVal(bodies[0],'Signatures'),'OFD_UNSUPPORTED_CONTENT','OFD 签章暂不支持，已停止导出以免遗漏。');
  const docPath=resolvePath('OFD.xml',xmlText(getXmlVal(bodies[0],'DocRoot')));
  const docContent=readTextFile(archive,docPath);
  requireCondition(docContent,'OFD_INVALID_XML','OFD 文档 XML 缺失。');
  const document=getXmlVal(xmlParser.parse(docContent),'Document');
  requireCondition(document,'OFD_INVALID_XML','OFD 文档结构无效。');
  onlyChildren(document,['CommonData','Pages','Outlines','Permissions','Actions','Attachments','CustomTags','Extensions']);
  const common=getXmlVal(document,'CommonData');
  const physicalBox=parseBox(xmlText(getXmlVal(getXmlVal(common,'PageArea'),'PhysicalBox'))||'0 0 210 297');
  const fonts=new Map(),images=new Map(),drawParams=new Map(),loadedResources=new Set();
  function loadResource(ref,relativeTo){
    const resourcePath=resolvePath(relativeTo,ref);
    if(loadedResources.has(resourcePath.toLowerCase()))return;
    const value=readTextFile(archive,resourcePath);
    requireCondition(value,'OFD_MISSING_RESOURCE','OFD 资源声明文件缺失。');
    parseResources(xmlParser.parse(value),fonts,images,resourcePath,drawParams);
    loadedResources.add(resourcePath.toLowerCase());
  }
  for(const kind of ['PublicRes','DocumentRes'])for(const ref of ensureArray(getXmlVal(common,kind)))loadResource(xmlText(ref),docPath);
  function loadPageResources(tree,pagePath){
    for(const ref of ensureArray(getXmlVal(getXmlVal(tree,'Page'),'PageRes')))loadResource(xmlText(ref),pagePath);
  }
  const templates=new Map();
  for(const ref of ensureArray(getXmlVal(common,'TemplatePage'))){
    await checkpoint(options.signal);
    const id=ref['@_ID'];requireCondition(id&&!templates.has(id),'OFD_INVALID_XML','OFD 模板 ID 无效。');
    const templatePath=resolvePath(docPath,ref['@_BaseLoc']);const value=readTextFile(archive,templatePath);
    requireCondition(value,'OFD_MISSING_PAGE','OFD 模板页缺失。');
    const tree=xmlParser.parse(value);loadPageResources(tree,templatePath);
    const tpl=parsePage(tree,id,-1,physicalBox,drawParams);
    tpl.zOrder=layerType(ref['@_ZOrder'],'Background');
    requireCondition(tpl.templates.length===0,'OFD_UNSUPPORTED_CONTENT','OFD 嵌套模板暂不支持。');
    for(const resource of tpl.pageResources)loadResource(resource,templatePath);
    templates.set(id,tpl);
  }
  const refs=ensureArray(getXmlVal(getXmlVal(document,'Pages'),'Page'));
  requireCondition(refs.length>0,'OFD_MISSING_PAGE','OFD 没有声明可读取页面。');
  requireCondition(refs.length<=OFD_LIMITS.pages,'OFD_RESOURCE_LIMIT','OFD 页数超出上限。');
  const pages=[];let objectCount=0;
  for(let index=0;index<refs.length;index++){
    await checkpoint(options.signal);
    const ref=refs[index];requireCondition(ref['@_BaseLoc'],'OFD_MISSING_PAGE','OFD 页引用缺失。');
    const pagePath=resolvePath(docPath,ref['@_BaseLoc']);const value=readTextFile(archive,pagePath);
    requireCondition(value,'OFD_MISSING_PAGE','OFD 第 '+(index+1)+' 页内容缺失。');
    const tree=xmlParser.parse(value);loadPageResources(tree,pagePath);
    const page=parsePage(tree,ref['@_ID']||String(index),index,physicalBox,drawParams);
    for(const resource of page.pageResources)loadResource(resource,pagePath);
    // GB/T 33190 layer groups: background template/layer, body template/layer,
    // foreground template/layer. Stable sorting preserves each group's XML order.
    const ordered=page.layers.map(layer=>({rank:LAYER_ORDER[layer.type],layer}));
    for(const template of page.templates){
      const tpl=templates.get(template.id);requireCondition(tpl,'OFD_MISSING_PAGE','OFD 页面引用的模板缺失。');
      const rank=LAYER_ORDER[template.zOrder||tpl.zOrder]-1;
      ordered.push(...tpl.layers.map(layer=>({rank,layer})));
    }
    page.layers=ordered.sort((a,b)=>a.rank-b.rank).map(item=>item.layer);
    objectCount+=page.layers.reduce((sum,layer)=>sum+layer.objects.length,0);
    requireCondition(objectCount<=OFD_LIMITS.objects,'OFD_RESOURCE_LIMIT','OFD 对象总数超出上限。');
    let checked=0;
    for(const obj of page.layers.flatMap(layer=>layer.objects)){
      if(++checked%64===0)await checkpoint(options.signal);else throwIfCanceled(options.signal);
      if(obj.type==='image'){const image=images.get(obj.resourceId);requireCondition(image&&readBinaryFile(archive,image.path),'OFD_MISSING_RESOURCE','OFD 第 '+(index+1)+' 页图像资源缺失。');}
      if(obj.type==='text')requireCondition(fonts.has(obj.font),'OFD_MISSING_RESOURCE','OFD 第 '+(index+1)+' 页字体声明缺失。');
    }
    pages.push(page);
  }
  for(const font of fonts.values())if(font.fontFile)requireCondition(readBinaryFile(archive,font.fontFile),'OFD_MISSING_RESOURCE','OFD 声明的字体文件缺失。');
  const doc={physicalBox,fonts,images,pages,basePath:docPath.split('/').slice(0,-1).join('/')};
  doc.inspection=await inspectDocument(doc,archive,options);
  return doc;
}
function parseResources(resXml,fonts,images,resourcePath,drawParams=new Map()){
  const res=getXmlVal(resXml,'Res');requireCondition(res,'OFD_INVALID_XML','OFD 资源 XML 无效。');
  const base=resolvePath(resourcePath,(res['@_BaseLoc']||'.').replace(/\/$/,'')+'/_resource_');
  for(const node of ensureArray(getXmlVal(getXmlVal(res,'DrawParams'),'DrawParam'))){
    const id=node['@_ID'];requireCondition(id&&!drawParams.has(id),'OFD_INVALID_XML','OFD 绘制参数 ID 缺失或重复。');
    drawParams.set(id,node);
  }
  for(const font of ensureArray(getXmlVal(getXmlVal(res,'Fonts'),'Font'))){
    const id=font['@_ID'];requireCondition(id&&!fonts.has(id),'OFD_INVALID_XML','OFD 字体 ID 缺失或重复。');
    const entry={id,name:font['@_FontName']||font['@_FamilyName']||'unknown',familyName:font['@_FamilyName'],italic:font['@_Italic']==='true',bold:font['@_Bold']==='true',serif:font['@_Serif']==='true',fixedWidth:font['@_FixedWidth']==='true'};
    const file=xmlText(getXmlVal(font,'FontFile'));if(file)entry.fontFile=resolvePath(base,file);
    fonts.set(id,entry);
  }
  for(const media of ensureArray(getXmlVal(getXmlVal(res,'MultiMedias'),'MultiMedia'))){
    if(media['@_Type']&&media['@_Type']!=='Image')continue;
    const id=media['@_ID'];const file=xmlText(getXmlVal(media,'MediaFile'));
    requireCondition(id&&file&&!images.has(id),'OFD_INVALID_XML','OFD 图像资源声明无效。');
    images.set(id,{id,path:resolvePath(base,file),format:(media['@_Format']||file.split('.').pop()).toUpperCase()});
  }
}
async function inspectDocument(doc,archive,options={}){
  const imageVisibility=new Map(),uniqueImages=new Map();
  const sharp=require('sharp');let totalPixels=0;
  try{
    // Preflight all distinct resources before decoding pixels. Repeated placements
    // reuse both these statistics and the renderer's embedded image stream.
    for(const page of doc.pages)for(const obj of page.layers.flatMap(layer=>layer.objects))if(obj.type==='image'){
      const resource=doc.images.get(obj.resourceId),key=resource.path.toLowerCase();
      if(uniqueImages.has(key))continue;
      await checkpoint(options.signal);
      const bytes=readBinaryFile(archive,resource.path);
      const info=await sharp(bytes,{limitInputPixels:OFD_LIMITS.imagePixels}).metadata();
      requireCondition(['png','jpeg'].includes(info.format),'OFD_UNSUPPORTED_CONTENT','OFD 图像编码暂不支持。');
      requireCondition(!info.pages||info.pages===1,'OFD_UNSUPPORTED_CONTENT','OFD 多帧图像暂不支持。');
      const pixels=info.width*info.height;
      requireCondition(Number.isSafeInteger(pixels)&&pixels>0&&pixels<=OFD_LIMITS.imagePixels,'OFD_RESOURCE_LIMIT','OFD 单张图像像素超出上限。');
      totalPixels+=pixels;
      requireCondition(totalPixels<=OFD_LIMITS.totalImagePixels,'OFD_RESOURCE_LIMIT','OFD 图像累计像素超出上限。');
      uniqueImages.set(key,bytes);
    }
    for(const [key,bytes] of uniqueImages){
      await checkpoint(options.signal);
      // sharp.stats() examines its input, not pending operations. Materialize the
      // alpha-composited RGB pixels before measuring visual content.
      const flattened=await sharp(bytes,{limitInputPixels:OFD_LIMITS.imagePixels}).flatten({background:'#ffffff'}).toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
      throwIfCanceled(options.signal);
      const stats=await sharp(flattened.data,{raw:{width:flattened.info.width,height:flattened.info.height,channels:flattened.info.channels},limitInputPixels:OFD_LIMITS.imagePixels}).stats();
      throwIfCanceled(options.signal);
      imageVisibility.set(key,stats.channels.slice(0,3).some(c=>c.min<250));
    }
  }catch(error){throwIfCanceled(options.signal);if(error.code?.startsWith('OFD_'))throw error;throw ofdError('OFD_RENDER_FAILED','OFD 图像数据无法完整解码。');}
  const dark=color=>!color||color.value.split(/\s+/).some(n=>Number(n)<250);
  return {pageCount:doc.pages.length,pages:doc.pages.map(page=>{
    const objects=page.layers.flatMap(layer=>layer.objects);
    const visible=objects.some(obj=>{
      if(obj.alpha===0||obj.boundary.width===0||obj.boundary.height===0)return false;
      if(obj.type==='image')return imageVisibility.get(doc.images.get(obj.resourceId).path.toLowerCase());
      if(obj.type==='text')return dark(obj.fillColor)&&obj.textCodes.some(tc=>/\S/u.test(tc.text));
      return (obj.fill&&dark(obj.fillColor))||(obj.stroke&&dark(obj.strokeColor));
    });
    return {index:page.index,id:page.id,objectCount:objects.length,hasContent:objects.length>0,expectsVisibleContent:visible};
  })};
}
async function inspect(input,options){return (await parse(input,options)).inspection;}
function findOfdXml(archive) {
  const candidates = ["OFD.xml", "ofd.xml", "OFD/OFD.xml"];
  for (const candidate of candidates) {
    const content = readTextFile(archive, candidate);
    if (content) return content;
  }
  for (const [path3] of archive) {
    if (path3.toLowerCase().endsWith("ofd.xml") && !path3.toLowerCase().includes("document")) {
      return readTextFile(archive, path3);
    }
  }
  return null;
}

// src/renderer/pdf-renderer.ts
var import_pdf_lib3 = require("pdf-lib");

// src/renderer/text-renderer.ts
var import_pdf_lib = require("pdf-lib");
var MM_TO_PT = 2.834645669;
function colorToRgb(color) {
  if (!color?.value) return (0, import_pdf_lib.rgb)(0, 0, 0);
  const parts = color.value.trim().split(/\s+/).map(Number);
  return (0, import_pdf_lib.rgb)(
    (parts[0] ?? 0) / 255,
    (parts[1] ?? 0) / 255,
    (parts[2] ?? 0) / 255
  );
}
function applyCTM(ctm, x, y) {
  return {
    x: ctm.a * x + ctm.c * y + ctm.e,
    y: ctm.b * x + ctm.d * y + ctm.f
  };
}
function decodeHtmlEntities(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&copy;/g, "\xA9").replace(/\n/g, "");
}
function applyCTMToDelta(dx, dy, ctm) {
  const angle = Math.atan2(-ctm.b, ctm.d);
  let resultDx = dx;
  let resultDy = dy;
  if (dx !== 0) {
    if (angle === 0) {
      const p = applyCTM(ctm, dx, 0);
      resultDx = p.x;
    }
  }
  if (dy !== 0) {
    if (angle === 0) {
      const p = applyCTM(ctm, 0, dy);
      resultDy = p.y;
    }
  }
  return { dx: resultDx, dy: resultDy };
}
const fontCharacterSets = new WeakMap();
function renderTextObject(page,textObj,font,pageHeight){
  const {boundary,textCodes,size,fillColor,ctm,alpha}=textObj;
  const fontSize=size*(ctm?.d||1)*MM_TO_PT;
  const color=colorToRgb(fillColor);let lastX=0,lastY=0;
  for(const tc of textCodes){
    const text=tc.text;if(!text)continue;
    const rawX=tc.x??lastX,rawY=tc.y??lastY;
    const position=ctm?applyCTM(ctm,rawX,rawY):{x:rawX,y:rawY};
    let x=(boundary.x+position.x)*MM_TO_PT,y=(pageHeight-boundary.y-position.y)*MM_TO_PT;
    if(font.getCharacterSet){let supported=fontCharacterSets.get(font);if(!supported){supported=new Set(font.getCharacterSet());fontCharacterSets.set(font,supported);}requireCondition([...text].every(c=>supported.has(c.codePointAt(0))),'OFD_UNSUPPORTED_CONTENT','OFD 字体缺少所需字符，已停止导出以免产生乱码。');}
    if(!tc.deltaX.length&&!tc.deltaY.length){page.drawText(text,{x,y,size:fontSize,font,color,opacity:alpha===undefined?undefined:alpha/255});lastX=rawX+font.widthOfTextAtSize(text,fontSize)/MM_TO_PT;lastY=rawY;continue;}
    let dxTotal=0,dyTotal=0;
    for(const [index,char] of [...text].entries()){
      page.drawText(char,{x,y,size:fontSize,font,color,opacity:alpha===undefined?undefined:alpha/255});
      const dx=tc.deltaX.length?tc.deltaX[Math.min(index,tc.deltaX.length-1)]:font.widthOfTextAtSize(char,size*MM_TO_PT)/MM_TO_PT;
      const dy=tc.deltaY.length?tc.deltaY[Math.min(index,tc.deltaY.length-1)]:0;
      dxTotal+=dx;dyTotal+=dy;x+=dx*(ctm?.a||1)*MM_TO_PT;y-=dy*(ctm?.d||1)*MM_TO_PT;
    }
    lastX=rawX+dxTotal;lastY=rawY+dyTotal;
  }
}

// src/renderer/path-renderer.ts
var import_pdf_lib2 = require("pdf-lib");
var MM_TO_PT2 = 2.834645669;
function parseColorComponents(color) {
  if (!color?.value) return { r: 0, g: 0, b: 0 };
  const parts = color.value.trim().split(/\s+/).map(Number);
  return {
    r: (parts[0] ?? 0) / 255,
    g: (parts[1] ?? 0) / 255,
    b: (parts[2] ?? 0) / 255
  };
}
function ctmScaleLineWidth(lineWidth, ctm) {
  const a = ctm.a;
  const c = ctm.c;
  const sx = Math.sign(a) * Math.sqrt(a * a + c * c);
  return lineWidth * Math.abs(sx);
}
function ctmTransformPoint(x, y, ctm) {
  return {
    x: ctm.a * x + ctm.c * y + ctm.e,
    y: ctm.b * x + ctm.d * y + ctm.f
  };
}
function arcToBeziers(x0, y0, rx, ry, angle, largeArcFlag, sweepFlag, x, y) {
  if (rx === 0 || ry === 0) {
    return [];
  }
  const phi = angle * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  let lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
  if (lambda > 1) {
    const sqrtLambda = Math.sqrt(lambda);
    rx *= sqrtLambda;
    ry *= sqrtLambda;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  let sq = Math.max(0, (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / (rx2 * y1p2 + ry2 * x1p2));
  sq = Math.sqrt(sq);
  if (largeArcFlag === sweepFlag) sq = -sq;
  const cxp = sq * (rx * y1p) / ry;
  const cyp = sq * -(ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;
  function vectorAngle(ux, uy, vx, vy) {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let cos = dot / len;
    cos = Math.max(-1, Math.min(1, cos));
    return sign * Math.acos(cos);
  }
  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = vectorAngle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  );
  if (!sweepFlag && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweepFlag && dTheta < 0) dTheta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const segmentAngle = dTheta / segments;
  const result = [];
  for (let i = 0; i < segments; i++) {
    let transform2 = function(px, py) {
      const sx = px * rx;
      const sy = py * ry;
      return [
        cosPhi * sx - sinPhi * sy + cx,
        sinPhi * sx + cosPhi * sy + cy
      ];
    };
    var transform = transform2;
    const startAngle = theta1 + i * segmentAngle;
    const endAngle = theta1 + (i + 1) * segmentAngle;
    const alpha = 4 / 3 * Math.tan(segmentAngle / 4);
    const cosStart = Math.cos(startAngle);
    const sinStart = Math.sin(startAngle);
    const cosEnd = Math.cos(endAngle);
    const sinEnd = Math.sin(endAngle);
    const p2x = cosStart - alpha * sinStart;
    const p2y = sinStart + alpha * cosStart;
    const p3x = cosEnd + alpha * sinEnd;
    const p3y = sinEnd - alpha * cosEnd;
    const p4x = cosEnd;
    const p4y = sinEnd;
    const [cp1x, cp1y] = transform2(p2x, p2y);
    const [cp2x, cp2y] = transform2(p3x, p3y);
    const [epx, epy] = transform2(p4x, p4y);
    result.push({
      x1: cp1x,
      y1: cp1y,
      x2: cp2x,
      y2: cp2y,
      x: epx,
      y: epy
    });
  }
  return result;
}
function toPdfCoord(x, y, boundary, pageHeight, ctm) {
  let px = x;
  let py = y;
  if (ctm) {
    const t = ctmTransformPoint(px, py, ctm);
    px = t.x;
    py = t.y;
  }
  return {
    x: (boundary.x + px) * MM_TO_PT2,
    y: (pageHeight - boundary.y - py) * MM_TO_PT2
  };
}
function renderPathObject(page, pathObj, pageHeight, pdfDoc) {
  const {
    boundary,
    commands,
    fillColor,
    strokeColor,
    lineWidth: lw,
    fill: doFill,
    stroke: doStroke,
    ctm,
    dashPattern,
    dashOffset,
    join,
    cap,
    miterLimit,
    alpha
  } = pathObj;
  if (commands.length === 0) return;
  const operators = [];
  operators.push((0, import_pdf_lib2.pushGraphicsState)());
  if (alpha != null && alpha < 255 && pdfDoc) {
    const opacity = alpha / 255;
    const extGState = pdfDoc.context.obj({
      Type: "ExtGState",
      ca: opacity,
      // fill opacity
      CA: opacity
      // stroke opacity
    });
    operators.push((0, import_pdf_lib2.setGraphicsState)(
      page.node.newExtGState("GS-a", extGState)
    ));
  }
  let lineWidth = (lw ?? 0.353) * MM_TO_PT2;
  if (ctm && lw != null) {
    lineWidth = ctmScaleLineWidth(lw * MM_TO_PT2, ctm);
  }
  operators.push((0, import_pdf_lib2.setLineWidth)(lineWidth));
  if (dashPattern && dashPattern.length >= 2) {
    const unitsOn = dashPattern[0] * MM_TO_PT2;
    const unitsOff = dashPattern[1] * MM_TO_PT2;
    const phase = (dashOffset ?? 0) * MM_TO_PT2;
    operators.push((0, import_pdf_lib2.setDashPattern)(dashPattern.map(n=>n*MM_TO_PT2), phase));
  }
  if (join) {
    const joinMap = { miter: import_pdf_lib2.LineJoinStyle.Miter, round: import_pdf_lib2.LineJoinStyle.Round, bevel: import_pdf_lib2.LineJoinStyle.Bevel };
    operators.push((0, import_pdf_lib2.setLineJoin)(joinMap[join]));
  }
  if (cap) {
    const capMap = { butt: import_pdf_lib2.LineCapStyle.Butt, round: import_pdf_lib2.LineCapStyle.Round, square: import_pdf_lib2.LineCapStyle.Projecting };
    operators.push((0, import_pdf_lib2.setLineCap)(capMap[cap]));
  }
  if (doFill && fillColor) {
    const fc = parseColorComponents(fillColor);
    operators.push((0, import_pdf_lib2.setFillingColor)((0, import_pdf_lib2.rgb)(fc.r, fc.g, fc.b)));
  }
  if (doStroke !== false) {
    const sc = parseColorComponents(strokeColor);
    operators.push((0, import_pdf_lib2.setStrokingColor)((0, import_pdf_lib2.rgb)(sc.r, sc.g, sc.b)));
  }
  let currentPtX = 0;
  let currentPtY = 0;
  let moveToX = 0;
  let moveToY = 0;
  for (const cmd of commands) {
    switch (cmd.type) {
      case "M": {
        const p = toPdfCoord(cmd.x, cmd.y, boundary, pageHeight, ctm);
        operators.push((0, import_pdf_lib2.moveTo)(p.x, p.y));
        currentPtX = p.x;
        currentPtY = p.y;
        moveToX = p.x;
        moveToY = p.y;
        break;
      }
      case "L": {
        const p = toPdfCoord(cmd.x, cmd.y, boundary, pageHeight, ctm);
        operators.push((0, import_pdf_lib2.lineTo)(p.x, p.y));
        currentPtX = p.x;
        currentPtY = p.y;
        break;
      }
      case "B": {
        const p1 = toPdfCoord(cmd.x1, cmd.y1, boundary, pageHeight, ctm);
        const p2 = toPdfCoord(cmd.x2, cmd.y2, boundary, pageHeight, ctm);
        const p = toPdfCoord(cmd.x, cmd.y, boundary, pageHeight, ctm);
        operators.push((0, import_pdf_lib2.appendBezierCurve)(p1.x, p1.y, p2.x, p2.y, p.x, p.y));
        currentPtX = p.x;
        currentPtY = p.y;
        break;
      }
      case "Q": {
        const qControl = toPdfCoord(cmd.x1, cmd.y1, boundary, pageHeight, ctm);
        const qEnd = toPdfCoord(cmd.x, cmd.y, boundary, pageHeight, ctm);
        const cp1x = currentPtX + 2 / 3 * (qControl.x - currentPtX);
        const cp1y = currentPtY + 2 / 3 * (qControl.y - currentPtY);
        const cp2x = qEnd.x + 2 / 3 * (qControl.x - qEnd.x);
        const cp2y = qEnd.y + 2 / 3 * (qControl.y - qEnd.y);
        operators.push((0, import_pdf_lib2.appendBezierCurve)(cp1x, cp1y, cp2x, cp2y, qEnd.x, qEnd.y));
        currentPtX = qEnd.x;
        currentPtY = qEnd.y;
        break;
      }
      case "A": {
        const arcEnd = toPdfCoord(cmd.x, cmd.y, boundary, pageHeight, ctm);
        const arcRx = cmd.rx * MM_TO_PT2;
        const arcRy = cmd.ry * MM_TO_PT2;
        const beziers = arcToBeziers(
          currentPtX,
          currentPtY,
          arcRx,
          arcRy,
          cmd.angle,
          cmd.large,
          cmd.sweep,
          arcEnd.x,
          arcEnd.y
        );
        if (beziers.length > 0) {
          for (const seg of beziers) {
            operators.push((0, import_pdf_lib2.appendBezierCurve)(
              seg.x1,
              seg.y1,
              seg.x2,
              seg.y2,
              seg.x,
              seg.y
            ));
          }
          const last = beziers[beziers.length - 1];
          currentPtX = last.x;
          currentPtY = last.y;
        } else {
          operators.push((0, import_pdf_lib2.lineTo)(arcEnd.x, arcEnd.y));
          currentPtX = arcEnd.x;
          currentPtY = arcEnd.y;
        }
        break;
      }
      case "C":
        operators.push((0, import_pdf_lib2.closePath)());
        currentPtX = moveToX;
        currentPtY = moveToY;
        break;
    }
  }
  if (doFill && doStroke !== false) {
    operators.push((0, import_pdf_lib2.fillAndStroke)());
  } else if (doFill) {
    operators.push((0, import_pdf_lib2.fill)());
  } else if (doStroke !== false) {
    operators.push((0, import_pdf_lib2.stroke)());
  }
  operators.push((0, import_pdf_lib2.popGraphicsState)());
  page.pushOperators(...operators);
}

// src/renderer/image-renderer.ts
var MM_TO_PT3 = 2.834645669;
function calculateImagePlacement(boundary, pageHeight, ctm) {
  if (ctm) {
    const width = Math.abs(ctm.a) * MM_TO_PT3;
    const height = Math.abs(ctm.d) * MM_TO_PT3;
    const x = (boundary.x + ctm.e) * MM_TO_PT3;
    const y = (pageHeight - boundary.y - ctm.f) * MM_TO_PT3 - height;
    return { x, y, width, height };
  }
  return {
    x: boundary.x * MM_TO_PT3,
    y: (pageHeight - boundary.y - boundary.height) * MM_TO_PT3,
    width: boundary.width * MM_TO_PT3,
    height: boundary.height * MM_TO_PT3
  };
}
async function renderImageObject(page,pdfDoc,imgObj,imageResource,archive,pageHeight,imageCache){
  requireCondition(imageResource,'OFD_MISSING_RESOURCE','OFD 图像资源声明缺失。');
  const data=readBinaryFile(archive,imageResource.path);
  requireCondition(data,'OFD_MISSING_RESOURCE','OFD 图像资源缺失。');
  try{
    const png=data[0]===137&&data[1]===80&&data[2]===78&&data[3]===71;
    const jpeg=data[0]===255&&data[1]===216;
    requireCondition(png||jpeg,'OFD_UNSUPPORTED_CONTENT','OFD 图像编码暂不支持。');
    const key=imageResource.path.toLowerCase();let embedded=imageCache.get(key);
    if(!embedded){embedded=png?await pdfDoc.embedPng(data):await pdfDoc.embedJpg(data);imageCache.set(key,embedded);}
    page.drawImage(embedded,{...calculateImagePlacement(imgObj.boundary,pageHeight,imgObj.ctm),opacity:imgObj.alpha===undefined?undefined:imgObj.alpha/255});
  }catch(error){if(error.code?.startsWith('OFD_'))throw error;throw ofdError('OFD_RENDER_FAILED','OFD 图像绘制失败。');}
}

// src/renderer/pdf-renderer.ts
var MM_TO_PT4 = 2.834645669;
function mapToStandardFont(ofdFont) {
  if (!ofdFont) return import_pdf_lib3.StandardFonts.Helvetica;
  const name = (ofdFont.name || "").toLowerCase();
  if (name.includes("song") || name.includes("\u5B8B") || name.includes("simsun"))
    return ofdFont.bold ? import_pdf_lib3.StandardFonts.TimesRomanBold : import_pdf_lib3.StandardFonts.TimesRoman;
  if (name.includes("hei") || name.includes("\u9ED1") || name.includes("simhei"))
    return ofdFont.bold ? import_pdf_lib3.StandardFonts.HelveticaBold : import_pdf_lib3.StandardFonts.Helvetica;
  if (name.includes("kai") || name.includes("\u6977") || name.includes("kaiti"))
    return ofdFont.italic ? import_pdf_lib3.StandardFonts.TimesRomanItalic : import_pdf_lib3.StandardFonts.TimesRoman;
  if (name.includes("fang") || name.includes("\u4EFF") || name.includes("fangsong"))
    return import_pdf_lib3.StandardFonts.TimesRoman;
  if (name.includes("courier") || name.includes("mono") || ofdFont.fixedWidth)
    return ofdFont.bold ? import_pdf_lib3.StandardFonts.CourierBold : import_pdf_lib3.StandardFonts.Courier;
  if (name.includes("times") || name.includes("serif") || ofdFont.serif) {
    if (ofdFont.bold && ofdFont.italic) return import_pdf_lib3.StandardFonts.TimesRomanBoldItalic;
    if (ofdFont.bold) return import_pdf_lib3.StandardFonts.TimesRomanBold;
    if (ofdFont.italic) return import_pdf_lib3.StandardFonts.TimesRomanItalic;
    return import_pdf_lib3.StandardFonts.TimesRoman;
  }
  if (ofdFont.bold && ofdFont.italic) return import_pdf_lib3.StandardFonts.HelveticaBoldOblique;
  if (ofdFont.bold) return import_pdf_lib3.StandardFonts.HelveticaBold;
  if (ofdFont.italic) return import_pdf_lib3.StandardFonts.HelveticaOblique;
  return import_pdf_lib3.StandardFonts.Helvetica;
}
function readBinaryFile2(archive,filePath){return filePath?readBinaryFile(archive,filePath):null;}
async function registerFontkit(pdfDoc){const fontkit=require('@pdf-lib/fontkit');pdfDoc.registerFontkit(fontkit.default||fontkit);return true;}
var KNOWN_CJK_FONTS = [
  // Google Noto CJK (TTF preferred)
  "NotoSansSC-Regular.ttf",
  "NotoSansCJKsc-Regular.ttf",
  "NotoSerifSC-Regular.ttf",
  "NotoSerifCJKsc-Regular.ttf",
  // Windows system fonts (all TTF)
  "simsun.ttf",
  "SimSun.ttf",
  "simhei.ttf",
  "SimHei.ttf",
  "msyh.ttf",
  "MSYH.ttf",
  "msyh.ttc",
  "simkai.ttf",
  "KaiTi.ttf",
  "simfang.ttf",
  "FangSong.ttf",
  "msyhbd.ttf",
  // WenQuanYi (Linux, TTF)
  "wqy-microhei.ttf",
  "wqy-zenhei.ttf",
  "WenQuanYiMicroHei.ttf",
  "WenQuanYiZenHei.ttf",
  // Adobe Source Han (TTF preferred, OTF fallback)
  "SourceHanSansSC-Regular.ttf",
  "SourceHanSansCN-Regular.ttf",
  "SourceHanSansSC-Regular.otf",
  "SourceHanSansCN-Regular.otf",
  "SourceHanSerifSC-Regular.otf",
  // Google Noto CJK OTF (last resort — may render blank with fontkit v1)
  "NotoSansCJKsc-Regular.otf",
  "NotoSansSC-Regular.otf",
  "NotoSerifCJKsc-Regular.otf",
  "NotoSerifSC-Regular.otf"
];
function getSystemFontDirs() {
  const platform = process.platform;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (platform === "win32") {
    return [
      path2.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "Fonts"),
      `${home}\\AppData\\Local\\Microsoft\\Windows\\Fonts`
    ];
  }
  if (platform === "darwin") {
    return [
      "/Library/Fonts",
      `${home}/Library/Fonts`,
      "/System/Library/Fonts/Supplemental",
      "/usr/local/share/fonts",
      "/opt/homebrew/share/fonts"
    ];
  }
  return [
    "/usr/share/fonts",
    "/usr/share/fonts/truetype",
    "/usr/share/fonts/opentype",
    "/usr/share/fonts/noto-cjk",
    "/usr/share/fonts/google-noto-cjk",
    "/usr/share/fonts/truetype/noto",
    "/usr/share/fonts/opentype/noto",
    "/usr/local/share/fonts",
    `${home}/.fonts`,
    `${home}/.local/share/fonts`
  ];
}
var cachedCJKFontPath = null;
function findSystemCJKFont() {
  if (cachedCJKFontPath !== null) return cachedCJKFontPath ?? void 0;
  const fs3 = require("fs");
  const path3 = require("path");
  const dirs = getSystemFontDirs();
  for (const dir of dirs) {
    for (const fontFile of KNOWN_CJK_FONTS) {
      const fullPath = path3.join(dir, fontFile);
      try {
        if (fs3.existsSync(fullPath)) {
          cachedCJKFontPath = fullPath;
          return fullPath;
        }
      } catch {
      }
    }
    try {
      if (fs3.existsSync(dir) && fs3.statSync(dir).isDirectory()) {
        const walkDir = (d, depth) => {
          if (depth > 2) return void 0;
          const entries = fs3.readdirSync(d, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && KNOWN_CJK_FONTS.includes(entry.name)) {
              const fp = path3.join(d, entry.name);
              cachedCJKFontPath = fp;
              return fp;
            }
          }
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const found2 = walkDir(path3.join(d, entry.name), depth + 1);
              if (found2) return found2;
            }
          }
          return void 0;
        };
        const found = walkDir(dir, 0);
        if (found) return found;
      }
    } catch {
    }
  }
  cachedCJKFontPath = void 0;
  return void 0;
}
var cachedCJKFontBytes = null;
function getCJKFontBytes(fontDir) {
  if (cachedCJKFontBytes) return cachedCJKFontBytes;
  const fs3 = require("fs");
  const path3 = require("path");
  if (fontDir) {
    for (const fontFile of KNOWN_CJK_FONTS) {
      const fullPath = path3.join(fontDir, fontFile);
      try {
        if (fs3.existsSync(fullPath)) {
          cachedCJKFontBytes = fs3.readFileSync(fullPath);
          return cachedCJKFontBytes;
        }
      } catch {
      }
    }
    try {
      const entries = fs3.readdirSync(fontDir);
      for (const entry of entries) {
        if (/\.(ttf|otf)$/i.test(entry)) {
          try {
            cachedCJKFontBytes = fs3.readFileSync(path3.join(fontDir, entry));
            return cachedCJKFontBytes;
          } catch {
            continue;
          }
        }
      }
    } catch {
    }
  }
  const systemPath = findSystemCJKFont();
  if (systemPath) {
    try {
      cachedCJKFontBytes = require("fs").readFileSync(systemPath);
      return cachedCJKFontBytes;
    } catch {
    }
  }
  return null;
}
async function renderToPdf(doc, archive, options = {}) {
  await checkpoint(options.signal);
  const pdfDoc = await import_pdf_lib3.PDFDocument.create();
  const hasFontkit = await registerFontkit(pdfDoc);
  pdfDoc.setTitle("Converted from OFD");
  pdfDoc.setProducer("ofd-to-pdf by Antigravity | miconvert.com");
  pdfDoc.setCreator("ofd-to-pdf (https://github.com/huuhuybn/miconvert-ofd-to-pdf)");
  const fontCache = /* @__PURE__ */ new Map();
  const defaultFont = await pdfDoc.embedFont(import_pdf_lib3.StandardFonts.Helvetica);
  const embeddedFontCache = /* @__PURE__ */ new Map();
  const imageCache = new Map();
  let cjkFont = null;
  if (hasFontkit) {
    const cjkBytes = getCJKFontBytes(options.fontDir);
    if (cjkBytes) {
      try {
        cjkFont = await pdfDoc.embedFont(cjkBytes, { subset: true });
      } catch {
        try {
          cjkFont = await pdfDoc.embedFont(cjkBytes, { subset: false });
        } catch {
        }
      }
    }
  }
  for (const [fontId, ofdFont] of doc.fonts) {
    await checkpoint(options.signal);
    let pdfFont = null;
    if (!pdfFont && hasFontkit && ofdFont.fontFile) {
      const fontPath = ofdFont.fontFile;
      const ext = fontPath.toLowerCase().split(".").pop() || "";
      if (["ttf", "otf", "woff"].includes(ext)) {
        if (embeddedFontCache.has(fontPath)) {
          pdfFont = embeddedFontCache.get(fontPath);
        } else {
          const fontBytes = readBinaryFile2(archive, fontPath);
          if (fontBytes && fontBytes.length > 100) {
            try {
              let embedded;
              try {
                embedded = await pdfDoc.embedFont(fontBytes, { subset: true });
              } catch {
                embedded = await pdfDoc.embedFont(fontBytes, { subset: false });
              }
              embeddedFontCache.set(fontPath, embedded);
              pdfFont = embedded;
            } catch {
            }
          }
        }
      }
    }
    if (ofdFont.fontFile && !pdfFont) throw ofdError("OFD_UNSUPPORTED_CONTENT", "OFD 内嵌字体无法读取，已停止导出以免替换文字。");
    if (!pdfFont && cjkFont) {
      const fontName = (ofdFont.name || "").toLowerCase();
      const isCJK = /[\u4e00-\u9fff]/.test(ofdFont.name || "") || fontName.includes("song") || fontName.includes("hei") || fontName.includes("kai") || fontName.includes("fang") || fontName.includes("sim") || fontName.includes("noto") || fontName.includes("pingfang") || fontName.includes("hiragino") || fontName.includes("source han") || fontName.includes("wenquanyi") || fontName.includes("stkaiti") || fontName.includes("stsong") || fontName.includes("stheiti") || fontName.includes("stfangsong") || fontName.includes("fz") || fontName.includes("adobe");
      if (isCJK) {
        pdfFont = cjkFont;
      }
    }
    if (!pdfFont) {
      const stdFont = mapToStandardFont(ofdFont);
      try {
        pdfFont = await pdfDoc.embedFont(stdFont);
      } catch {
        pdfFont = defaultFont;
      }
    }
    fontCache.set(fontId, pdfFont);
  }
  for (const ofdPage of doc.pages) {
    await checkpoint(options.signal);
    const pageArea = ofdPage.area ?? doc.physicalBox;
    const pageWidth = pageArea.width * MM_TO_PT4;
    const pageHeight = pageArea.height * MM_TO_PT4;
    const pdfPage = pdfDoc.addPage([pageWidth, pageHeight]);
    for (const layer of ofdPage.layers) {
      let rendered=0;
      for (const obj of layer.objects) {
        if(++rendered%64===0)await checkpoint(options.signal);else throwIfCanceled(options.signal);
        try {
          switch (obj.type) {
            case "text": {
              const font = fontCache.get(obj.font) ?? defaultFont;
              renderTextObject(pdfPage, obj, font, pageArea.height);
              break;
            }
            case "path": {
              renderPathObject(pdfPage, obj, pageArea.height, pdfDoc);
              break;
            }
            case "image": {
              const imageResource = doc.images.get(obj.resourceId);
              await renderImageObject(pdfPage, pdfDoc, obj, imageResource, archive, pageArea.height, imageCache);
              break;
            }
          }
        } catch (error) {
          if (error.code?.startsWith("OFD_")) throw error;
          throw ofdError("OFD_RENDER_FAILED", "OFD 第 "+(ofdPage.index+1)+" 页对象绘制失败。");
        }
      }
    }
    if (options.watermark) {
      const watermarkFont = await pdfDoc.embedFont(import_pdf_lib3.StandardFonts.HelveticaOblique);
      const watermarkText = "Powered by Antigravity | miconvert.com";
      const watermarkSize = 8;
      const textWidth = watermarkFont.widthOfTextAtSize(watermarkText, watermarkSize);
      pdfPage.drawText(watermarkText, {
        x: pageWidth - textWidth - 10,
        y: 10,
        size: watermarkSize,
        font: watermarkFont,
        color: (0, import_pdf_lib3.rgb)(0.75, 0.75, 0.75),
        opacity: 0.5
      });
    }
  }
  await checkpoint(options.signal);
  try { const bytes=await pdfDoc.save();await checkpoint(options.signal);return bytes; } catch { throwIfCanceled(options.signal);throw ofdError("OFD_RENDER_FAILED", "OFD PDF 写出失败。"); }
}
// src/index.ts
var _brandingShown = false;
function showBranding(silent) {
  if (_brandingShown || silent) return;
  _brandingShown = true;
  console.log("\x1B[36m\u26A1 ofd-to-pdf\x1B[0m \u2014 Powered by \x1B[1mAntigravity\x1B[0m | \x1B[4mmiconvert.com\x1B[0m");
}
async function convert(input, outputOrOptions, maybeOptions) {
  let outputPath;
  let options = {};
  if (typeof outputOrOptions === "string") {
    outputPath = outputOrOptions;
    options = maybeOptions ?? {};
  } else if (typeof outputOrOptions === "object" && outputOrOptions !== null && !(outputOrOptions instanceof ArrayBuffer) && !(outputOrOptions instanceof Uint8Array)) {
    options = outputOrOptions;
  } else if (maybeOptions) { options = maybeOptions; }
  showBranding(options.silent ?? false);
  const archive = await extractOfd(input,options);
  const doc = await parseOfdXml(archive,options);
  if (options.onInspect) await options.onInspect(doc.inspection);
  const pdfBytes = await renderToPdf(doc, archive, options);
  throwIfCanceled(options.signal);
  if (outputPath) {
    const dir = path2.dirname(outputPath);
    if (!fs2.existsSync(dir)) {
      fs2.mkdirSync(dir, { recursive: true });
    }
    fs2.writeFileSync(outputPath, pdfBytes);
    return;
  }
  return pdfBytes;
}
async function parse(input,options={}) {
  const archive = await extractOfd(input,options);
  return parseOfdXml(archive,options);
}
var index_default = { convert, parse };
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  convert,
  parse
});
/**
 * ofd-to-pdf
 *
 * High-performance OFD to PDF converter for Node.js
 * Node.js OFD 转 PDF 高性能转换器
 *
 * Built by [MiConvert](https://miconvert.com/en/ofd-to-pdf?utm_source=jsr&utm_medium=listing&utm_campaign=ofd-to-pdf) —
 * free online OFD to PDF conversion, no install required.
 *
 * @packageDocumentation
 * @module ofd-to-pdf
 * @author Antigravity <dev@miconvert.com>
 * @license Apache-2.0
 */
