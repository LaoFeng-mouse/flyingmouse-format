const assert = require("node:assert/strict");
const { test } = require("node:test");

const { mergeOcrChineseWords, mergeCnSpaces } = require("../pdf-table-runtime");

test("mergeOcrChineseWords 合并同行 x 邻近的中文碎片", () => {
  const words = [
    { text: "零", x: 734, y: 237, width: 72, height: 128 },
    { text: "申", x: 806, y: 237, width: 64, height: 128 },
    { text: "报", x: 870, y: 237, width: 72, height: 128 },
    { text: "确认", x: 942, y: 237, width: 120, height: 128 },
    { text: "表", x: 1062, y: 237, width: 64, height: 128 }
  ];
  const merged = mergeOcrChineseWords(words);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "零申报确认表");
  assert.equal(merged[0].x, 734);
});

test("mergeOcrChineseWords 不合并英文/数字词", () => {
  const words = [
    { text: "ID3", x: 2, y: 3, width: 30, height: 10 },
    { text: "tags", x: 40, y: 3, width: 40, height: 10 }
  ];
  const merged = mergeOcrChineseWords(words);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "ID3");
  assert.equal(merged[1].text, "tags");
});

test("mergeOcrChineseWords 不合并 y 差距大的行", () => {
  const words = [
    { text: "标题", x: 10, y: 100, width: 40, height: 20 },
    { text: "正文", x: 60, y: 300, width: 40, height: 20 }
  ];
  const merged = mergeOcrChineseWords(words);
  assert.equal(merged.length, 2);
});

test("mergeOcrChineseWords 保留中文与英文之间的边界（x 间距大不合并）", () => {
  const words = [
    { text: "编号", x: 10, y: 50, width: 40, height: 20 },
    { text: "A123", x: 200, y: 50, width: 60, height: 20 }
  ];
  const merged = mergeOcrChineseWords(words);
  assert.equal(merged.length, 2);
});

test("mergeCnSpaces 删除汉字间空格但保留汉字与数字/英文间空格", () => {
  assert.equal(mergeCnSpaces("纳税 人 名 称"), "纳税人名称");
  assert.equal(mergeCnSpaces("批量 零 申 报 确认 表"), "批量零申报确认表");
  assert.equal(mergeCnSpaces("2017 年 1 月"), "2017 年 1 月"); // 数字-汉字间空格保留
  assert.equal(mergeCnSpaces("税 款 所 属 期 起"), "税款所属期起");
  assert.equal(mergeCnSpaces("91440604579670475R"), "91440604579670475R"); // 纯数字不动
  assert.equal(mergeCnSpaces(""), "");
  assert.equal(mergeCnSpaces(null), "");
});
