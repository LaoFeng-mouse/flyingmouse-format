"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { targetsForExt, categoryForExt } = require("../utils");

test("pdf 输入类别正确", () => {
  assert.equal(categoryForExt("pdf"), "pdf");
});

test("pdf 暴露 ODT 目标（LibreOffice 可用）", () => {
  const targets = targetsForExt("pdf", { libreoffice: true, poppler: true });
  assert.ok(targets.includes("odt"), "pdf 在有 LibreOffice 时应暴露 odt");
});

test("pdf 隐藏 ODT 目标（无 LibreOffice，如 win7 构建）", () => {
  const targets = targetsForExt("pdf", { libreoffice: false, poppler: true });
  assert.ok(!targets.includes("odt"), "无 LibreOffice 时不应暴露 odt");
  // 其它 PDF 目标不受影响
  assert.ok(targets.includes("docx"), "docx 仍应暴露");
  assert.ok(targets.includes("xlsx"), "xlsx 仍应暴露");
});

test("pdf 既有目标不回归（docx/xlsx/txt/html/png/jpg/pdf/odt）", () => {
  const targets = targetsForExt("pdf", { libreoffice: true, poppler: true });
  for (const t of ["docx", "xlsx", "txt", "html", "png", "jpg", "pdf", "odt"]) {
    assert.ok(targets.includes(t), `pdf 应暴露 ${t}`);
  }
});

// ofd 仍只转 pdf（不因 pdfTextTargets 加了 odt 而松绑）
test("ofd 目标仍仅限 pdf（避免 pdf-odt 改动误伤 ofd）", () => {
  const targets = targetsForExt("ofd", { libreoffice: true, poppler: true });
  assert.ok(!targets.includes("odt"), "ofd 不应暴露 odt");
});
