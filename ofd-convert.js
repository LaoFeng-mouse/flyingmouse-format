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

module.exports = { convertOfdToPdf };
