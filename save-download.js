// save-download.js — 保存链路的下载落盘（0.6.10 P1 修复时从 electron-main.js 抽出）。
//
// 核心不变量（2026-09-10 全面复核 P1：旧实现在任何失败时 rm 用户选择的最终
// 目标路径，HTTP 404（写流都还没建）也走这条删除——「保存失败误删已有文件」）：
//   下载永远只写目标同目录的随机 .partial 临时文件；收全、关流、字节数校验
//   通过后才 rename 发布为最终文件。任何失败路径只清理本次创建的 .partial，
//   绝不触碰 destination——用户已存在的旧文件要么原样保留、要么被完整的
//   新内容一次性替换，不存在「保存失败 → 旧文件没了」的中间态。
//   （覆盖同名文件由系统 rename 语义保证；rename 失败时旧文件仍在。）

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

// 下载空闲超时：60 秒内 socket 无任何数据视为断链（大文件持续传输会不断重置该计时）。
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;

// .partial 放在最终目录里（同卷 rename 才是原子的），随机后缀防同目录并发互踩。
function partialPathFor(destination) {
  const dir = path.dirname(destination);
  const base = path.basename(destination);
  return path.join(dir, `${base}.${crypto.randomBytes(6).toString("hex")}.partial`);
}

function downloadToFile(url, destination, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const client = url.startsWith("https:") ? https : http;
  const partialPath = partialPathFor(destination);
  return new Promise((resolve, reject) => {
    let settled = false;

    // 失败清理只允许针对 partialPath——destination 归用户，本函数无权删除。
    const fail = (error) => {
      if (settled) return;
      settled = true;
      const wrapped = error instanceof Error ? error : new Error(String(error));
      log(`Save failed: ${destination}`, wrapped);
      fs.promises.rm(partialPath, { force: true })
        .catch((cleanupError) => log(`Failed to remove partial file: ${partialPath}`, cleanupError))
        .finally(() => reject(wrapped));
    };

    const request = client.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        // 重定向目标必须重新过信任校验（由调用方注入）；拒绝时旧目标同样不动。
        settled = true;
        let redirectedUrl = null;
        let redirectError = null;
        try {
          if (typeof options.resolveRedirect !== "function") {
            throw new Error("保存失败：无法校验重定向地址。");
          }
          redirectedUrl = options.resolveRedirect(new URL(response.headers.location, url).toString());
        } catch (error) {
          redirectError = error;
        }
        if (redirectError) {
          fs.promises.rm(partialPath, { force: true }).catch(() => {});
          reject(redirectError);
          return;
        }
        downloadToFile(redirectedUrl, destination, options).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        // 产物登记表在内存里且运行期间不再过期（2026-09-07 决策）。404 如今只可能
        // 来自服务重启/窗口会话更替，给可行动提示而不是裸状态码。
        // P1：此前这里会删 destination——404 时目标若是用户已有文件即被误删。
        fail(new Error(response.statusCode === 404
          ? "保存失败：该转换结果已失效（程序可能重启过），请重新转换后再保存。"
          : `保存失败：下载服务返回 ${response.statusCode}`));
        return;
      }

      const expectedBytes = Number(response.headers["content-length"]);
      let receivedBytes = 0;
      response.on("data", (chunk) => { receivedBytes += chunk.length; });
      response.on("error", (error) => fail(error));
      response.on("aborted", () => fail(new Error("保存失败：下载连接被中断，文件未完整写入。")));

      const file = fs.createWriteStream(partialPath);
      file.on("error", (error) => fail(error));
      file.on("finish", () => {
        file.close((closeError) => {
          if (closeError) {
            fail(closeError);
            return;
          }
          if (Number.isFinite(expectedBytes) && expectedBytes > 0 && receivedBytes !== expectedBytes) {
            fail(new Error(`保存失败：文件不完整（已写入 ${receivedBytes} 字节，期望 ${expectedBytes} 字节）。`));
            return;
          }
          // 完整性确认后才发布：rename 覆盖/新建最终目标；失败则旧文件原样保留。
          fs.promises.rename(partialPath, destination).then(() => {
            if (settled) return;
            settled = true;
            log(`Saved converted file: ${destination} (${receivedBytes} bytes)`);
            resolve();
          }, (renameError) => {
            fail(new Error(`保存失败：无法写入目标文件（已有文件保持原样）。${renameError instanceof Error ? renameError.message : renameError}`));
          });
        });
      });
      response.pipe(file);
    });

    request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`保存失败：下载超时（${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒无数据），文件未完整写入。`));
    });
    request.on("error", (error) => fail(error));
  });
}

module.exports = { downloadToFile, partialPathFor, DOWNLOAD_IDLE_TIMEOUT_MS };
