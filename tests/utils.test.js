const assert = require("node:assert/strict");
const { test } = require("node:test");

const { decodeUploadFileName, safeBaseName, extFromName } = require("../utils");

test("decodeUploadFileName 还原 UTF-8 mojibake（浏览器 FormData 场景）", () => {
  // 「测试音频」UTF-8 字节被 latin1 解码后的样子
  const mojibake = Buffer.from("测试音频", "utf8").toString("latin1");
  assert.equal(decodeUploadFileName(mojibake), "测试音频");
});

test("decodeUploadFileName 还原 GBK mojibake（curl/命令行/微信传输场景）", () => {
  // 用显式 GBK 字节构造 mojibake 样本（Node Buffer 不支持 gbk 编码，
  // 但 TextDecoder('gbk') 能解码这些字节——正好模拟 curl/命令行场景：
  // 中文 Windows 系统代码页=GBK，上传文件名按 GBK 字节被 multer latin1 读）。
  const toLatin1View = (gbkBytes) => Buffer.from(gbkBytes).toString("latin1");
  // 测试音频 = B2E2 CAD4 D2F4 C6B5
  const ceShi = toLatin1View([0xB2, 0xE2, 0xCA, 0xD4, 0xD2, 0xF4, 0xC6, 0xB5]);
  assert.equal(decodeUploadFileName(ceShi), "测试音频");
  // 白兰的-得意的笑 = B0D7 C0BC B5C4 2D B5C3 D2E2 B5C4 D0A6
  const baiLan = toLatin1View([0xB0, 0xD7, 0xC0, 0xBC, 0xB5, 0xC4, 0x2D, 0xB5, 0xC3, 0xD2, 0xE2, 0xB5, 0xC4, 0xD0, 0xA6]);
  assert.equal(decodeUploadFileName(baiLan), "白兰的-得意的笑");
  // Zhen Zhen （半夏水玉）-目瑙纵歌：直接用 2026-08-14 curl 实测抓到的
  // GBK-latin1 乱码字符串（真实场景样本，无需手算 GBK 字节）
  const zhenReal = "Zhen Zhen £¨°ëÏÄË®Óñ£©-Ä¿è§×Ý¸è";
  assert.equal(decodeUploadFileName(zhenReal), "Zhen Zhen （半夏水玉）-目瑙纵歌");
});

test("decodeUploadFileName 保持英文/ASCII 文件名不变", () => {
  assert.equal(decodeUploadFileName("test-audio.mp3"), "test-audio.mp3");
  assert.equal(decodeUploadFileName("song.flac"), "song.flac");
  assert.equal(decodeUploadFileName(""), "file");
});

test("decodeUploadFileName 保持已正确的中文 UTF-8 名不变（不二次转换）", () => {
  assert.equal(decodeUploadFileName("测试音频.mp3"), "测试音频.mp3");
  assert.equal(decodeUploadFileName("白兰的-得意的笑.mp3"), "白兰的-得意的笑.mp3");
});

test("decodeUploadFileName 对无效输入回退原值", () => {
  assert.equal(decodeUploadFileName(null), "file");
  assert.equal(decodeUploadFileName(undefined), "file");
  assert.equal(decodeUploadFileName(42), "42");
});

test("extFromName / safeBaseName 对中文名正常", () => {
  assert.equal(extFromName("白兰的-得意的笑.mp3"), "mp3");
  assert.equal(safeBaseName("白兰的-得意的笑.mp3"), "白兰的-得意的笑");
  assert.equal(safeBaseName("Zhen Zhen （半夏水玉）-目瑙纵歌.kwm"), "Zhen Zhen （半夏水玉）-目瑙纵歌");
});
