"use strict";

const fs = require("fs");
const path = require("path");

// OFD（开放版式文档，国标 GB/T 33190）→ PDF。
//
// 转换内核：@miconvert/ofd-to-pdf（Apache-2.0，纯 JS，无原生依赖）。
// 流程：OFD 是 ZIP 容器 → 解包 → 解析 OFD.xml/Document.xml → pdf-lib 排版输出。
// 转出 PDF 后自动复用现有 PDF→图片/文字/Word 全链路。
//
// 依赖说明（fast-xml-parser 4.x 存在 2 个 moderate advisory，无 4.x 修复版）：
// 该库仅使用 XMLParser 解析方向；advisory 针对 XMLBuilder 写入方向（XML 注释/CDATA
// 注入），本项目不构建 XML，风险不适用。OFD 为本地用户文件，无外部不可信输入。
// 若后续 npm 有 5.x 修复版且锁文件可平滑升级，再评估迁移。

/**
 * 清掉 @miconvert/ofd-to-pdf 的 require 缓存，让每次转换都拿到全新模块实例。
 *
 * 为什么必须这么做（2026-08-31 实测并修复）：
 * 该库有模块级字体状态，首次 convert 之后就被消耗掉。同一进程第 2 次起产出的 PDF
 * 文字层失效——pdfjs 提取到 0 个汉字、约 45% 字符变成 "?"，体积从 81.8KB 变 84.9KB
 * （视觉页面还在，但不能复制、不能检索、后续 PDF→Word/TXT 全链路也拿不到文字）。
 * 桌面版本地 server 是长驻进程，批量转换更是同一进程内连续调用，等于「除第一份 OFD
 * 之外全部退化」。清缓存后连续 8 次输出稳定：均 1136 汉字、体积一致，rss 在 ~310MB
 * 收敛（旧模块副本无引用可被 GC 回收）。
 *
 * 注意：不要改成只在「第二次及以后」清——首次也清才能保证行为一致、可复现。
 * @returns {number} 被清掉的模块条目数
 */
function purgeOfdConverterCache() {
  const mark = `${path.sep}@miconvert${path.sep}`;
  let purged = 0;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(mark)) {
      delete require.cache[key];
      purged += 1;
    }
  }
  return purged;
}

/**
 * 将 OFD 文件转换为 PDF。
 * @param {string} inputPath   源 OFD 文件路径（multer 临时文件可能无扩展名）
 * @param {string} outputPath  目标 PDF 文件路径
 * @param {string} [originalName] 用户原始文件名，用于扩展名校验（优先于 inputPath）
 * @returns {Promise<void>}
 */
async function convertOfdToPdf(inputPath, outputPath, originalName) {
  if (!fs.existsSync(inputPath)) {
    throw new Error("OFD 源文件不存在，无法转换。");
  }
  const stat = fs.statSync(inputPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error("OFD 源文件为空或不可读，无法转换。");
  }
  const checkName = originalName || inputPath;
  if (path.extname(checkName).toLowerCase() !== ".ofd") {
    throw new Error("仅支持转换 .ofd 格式的 OFD 文件。");
  }

  let ofdConverter;
  try {
    purgeOfdConverterCache();
    ofdConverter = require("@miconvert/ofd-to-pdf");
  } catch (error) {
    throw new Error("OFD 转换组件未安装，暂时无法转换 OFD 文件。");
  }
  const convert = typeof ofdConverter.convert === "function" ? ofdConverter.convert : null;
  if (!convert) {
    throw new Error("OFD 转换组件异常（缺少 convert 接口），暂时无法转换 OFD 文件。");
  }

  try {
    await convert(inputPath, outputPath);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    throw new Error(`OFD 转 PDF 失败：${reason}`);
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error("OFD 转换未产出有效 PDF 文件。");
  }
}

module.exports = { convertOfdToPdf, purgeOfdConverterCache };
