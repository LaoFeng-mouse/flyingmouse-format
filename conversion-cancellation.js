let applicationClosing = false;

function cancellationError() {
  return Object.assign(new Error("转换已取消。"), {
    code: "CONVERSION_CANCELED",
    messages: { zhCN: "转换已取消。", enUS: "Conversion canceled." }
  });
}

function throwIfCanceled(signal) {
  if (applicationClosing || signal?.aborted) throw cancellationError();
}

function beginApplicationShutdown() { applicationClosing = true; }

module.exports = { cancellationError, throwIfCanceled, beginApplicationShutdown };
