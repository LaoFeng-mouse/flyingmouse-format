const state = {
  files: [],
  fileInfos: [],
  capabilities: null,
  converted: null,
  batchResults: [],
  isConverting: false,
  progressValue: 0
};

const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const fileStrip = document.querySelector("#fileStrip");
const fileName = document.querySelector("#fileName");
const fileMeta = document.querySelector("#fileMeta");
const targetSelect = document.querySelector("#targetSelect");
const convertButton = document.querySelector("#convertButton");
const clearButton = document.querySelector("#clearButton");
const statusBox = document.querySelector("#statusBox");
const downloadButton = document.querySelector("#downloadButton");
const batchSaveButton = document.querySelector("#batchSaveButton");
const toolHealth = document.querySelector("#toolHealth");
const formatTable = document.querySelector("#formatTable");
const dropHint = document.querySelector("#dropHint");
const batchList = document.querySelector("#batchList");
const progressPanel = document.querySelector("#progressPanel");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressTrack = document.querySelector(".progress-track");
const progressFill = document.querySelector("#progressFill");
const mouseMascot = document.querySelector("#mouseMascot");
const workflowSteps = [...document.querySelectorAll("[data-step]")];

const mouseAssets = {
  idle: "/assets/mouse-format/mouse-idle.png",
  upload: "/assets/mouse-format/mouse-upload.png",
  analyzing: "/assets/mouse-format/mouse-analyzing.png",
  converting: "/assets/mouse-format/mouse-converting.png",
  pdfPages: "/assets/mouse-format/mouse-pdf-pages.png",
  ocr: "/assets/mouse-format/mouse-ocr.png",
  batch: "/assets/mouse-format/mouse-batch.png",
  success: "/assets/mouse-format/mouse-success.png",
  error: "/assets/mouse-format/mouse-error.png"
};

const labels = {
  image: "图片",
  text: "文本",
  document: "Word/WPS 文档",
  spreadsheet: "Excel/WPS 表格",
  presentation: "PPT/WPS 演示",
  pdf: "PDF",
  audio: "音频",
  video: "视频",
  any: "任意文件",
  unknown: "未知类型"
};

const statusLabels = {
  pending: "等待",
  converting: "转换中",
  success: "完成",
  error: "失败"
};

function extensionOf(name) {
  const parts = String(name || "").split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setSelectPlaceholder(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.replaceChildren(option);
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function setStatus(message, type = "") {
  statusBox.textContent = message;
  statusBox.className = `status-box ${type}`.trim();
}

function setMouseState(name) {
  if (!mouseMascot) return;
  const src = mouseAssets[name] || mouseAssets.idle;
  mouseMascot.src = src;
  mouseMascot.dataset.state = name;
}

function setWorkflowStep(step) {
  for (const item of workflowSteps) {
    item.classList.toggle("active", item.dataset.step === step);
  }
}

function mouseStateForConversion(targetFormat) {
  if (state.files.length > 1) return "batch";
  if (targetFormat === "txt" && state.fileInfos.some((info) => info.category === "image" || info.category === "pdf")) {
    return "ocr";
  }
  if ((targetFormat === "png" || targetFormat === "jpg") && state.fileInfos.some((info) => info.category === "pdf")) {
    return "pdfPages";
  }
  return "converting";
}

function setProgress(value, label, type = "") {
  const safeValue = Math.max(0, Math.min(100, Math.round(value)));
  state.progressValue = safeValue;
  progressPanel.hidden = false;
  progressPanel.className = `progress-panel ${type}`.trim();
  progressLabel.textContent = label;
  progressPercent.textContent = `${safeValue}%`;
  progressFill.style.width = `${safeValue}%`;
  progressTrack.setAttribute("aria-valuenow", String(safeValue));
}

function resetProgress() {
  state.progressValue = 0;
  progressPanel.hidden = true;
  progressPanel.className = "progress-panel";
  progressLabel.textContent = "转换进度";
  progressPercent.textContent = "0%";
  progressFill.style.width = "0%";
  progressTrack.setAttribute("aria-valuenow", "0");
}

function resetDownload() {
  state.converted = null;
  state.batchResults = [];
  downloadButton.hidden = true;
  downloadButton.removeAttribute("href");
  downloadButton.removeAttribute("download");
  batchSaveButton.hidden = true;
}

function clearFile() {
  state.files = [];
  state.fileInfos = [];
  state.isConverting = false;
  fileInput.value = "";
  fileStrip.hidden = true;
  batchList.hidden = true;
  batchList.replaceChildren();
  setSelectPlaceholder(targetSelect, "", "先选择文件");
  targetSelect.disabled = true;
  convertButton.disabled = true;
  resetDownload();
  resetProgress();
  setStatus("选择文件后会显示可用的转换格式。");
  setMouseState("upload");
  setWorkflowStep("select");
}

async function fetchCapabilities() {
  const response = await fetch("/api/capabilities");
  if (!response.ok) throw new Error("无法读取转换能力。");
  state.capabilities = await response.json();

  const enabled = ["图片", "文本", "PDF", "ZIP"];
  if (state.capabilities.tools.libreoffice) enabled.push("Office/WPS");
  if (state.capabilities.tools.ffmpeg) enabled.push("音视频");
  toolHealth.textContent = `${enabled.join("、")} 已启用`;
  toolHealth.classList.add("ok");

  if (!state.capabilities.tools.libreoffice) {
    dropHint.textContent = "PDF 表格可以转 Excel；Office/WPS 需要内置 LibreOffice";
  }

  renderFormatTable();
}

function renderFormatTable() {
  const groups = state.capabilities?.groups || {};
  const items = [
    ["image", groups.image],
    ["text", groups.text],
    ["document", groups.document],
    ["spreadsheet", groups.spreadsheet],
    ["presentation", groups.presentation],
    ["pdf", groups.pdf],
    ["audio", groups.audio],
    ["video", groups.video],
    ["any", groups.any]
  ].filter(([, group]) => group);

  const entries = items.map(([key, group]) => {
    const article = document.createElement("article");
    article.className = "format-item";
    article.append(
      createTextElement("h3", "", labels[key]),
      createTextElement("p", "", `输入：${group.inputs.join(", ")}`),
      createTextElement("p", "", `输出：${group.targets.join(", ")}`)
    );
    return article;
  });
  formatTable.replaceChildren(...entries);
}

async function loadTargets(file) {
  const extension = extensionOf(file.name);
  const response = await fetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension })
  });

  if (!response.ok) throw new Error("无法判断目标格式。");
  return response.json();
}

function commonTargetsFrom(infos) {
  if (!infos.length) return [];
  const [first, ...rest] = infos;
  const common = new Set(first.targets);
  for (const info of rest) {
    for (const target of [...common]) {
      if (!info.targets.includes(target)) common.delete(target);
    }
  }
  return [...common];
}

function summarizeFiles(files) {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length === 1) {
    return {
      name: files[0].name,
      meta: `${formatSize(files[0].size)} · ${files[0].type || "未知 MIME"}`
    };
  }
  return {
    name: `已选择 ${files.length} 个文件`,
    meta: `总大小 ${formatSize(totalBytes)} · 将按队列逐个转换`
  };
}

function renderBatchList() {
  if (!state.files.length) {
    batchList.hidden = true;
    batchList.replaceChildren();
    return;
  }

  batchList.hidden = false;
  const entries = state.files.map((file, index) => {
    const result = state.batchResults[index] || { status: "pending", detail: "等待转换" };
    const article = document.createElement("article");
    article.className = `batch-item ${result.status}`;

    const main = document.createElement("div");
    main.className = "batch-main";
    main.append(
      createTextElement("p", "batch-name", file.name),
      createTextElement("p", "batch-detail", result.detail || statusLabels[result.status] || "")
    );

    const actions = document.createElement("div");
    actions.className = "batch-actions";
    actions.append(createTextElement("span", "batch-status", statusLabels[result.status] || "等待"));
    if (result.status === "success" && result.result) {
      const saveButton = createTextElement("button", "mini-button", "保存");
      saveButton.type = "button";
      saveButton.dataset.saveIndex = String(index);
      actions.append(saveButton);
    }

    article.append(main, actions);
    return article;
  });
  batchList.replaceChildren(...entries);
}

function setBatchResult(index, patch) {
  state.batchResults[index] = {
    ...(state.batchResults[index] || { status: "pending", detail: "等待转换" }),
    ...patch
  };
  renderBatchList();
}

async function acceptFiles(fileList) {
  const files = [...fileList].filter((file) => file && file.size >= 0);
  if (!files.length) return;

  state.files = files;
  state.fileInfos = [];
  state.batchResults = files.map(() => ({ status: "pending", detail: "等待转换" }));
  resetDownload();
  resetProgress();
  setMouseState("analyzing");
  if (files.length > 1) {
    setMouseState("batch");
  }
  setWorkflowStep("analyze");

  const summary = summarizeFiles(files);
  fileName.textContent = summary.name;
  fileMeta.textContent = summary.meta;
  fileStrip.hidden = false;
  renderBatchList();

  targetSelect.disabled = true;
  convertButton.disabled = true;
  setSelectPlaceholder(targetSelect, "", "正在识别");
  setStatus(files.length === 1 ? "正在分析文件类型和可用转换格式..." : `正在分析 ${files.length} 个文件的共同转换格式...`);

  try {
    const infos = await Promise.all(files.map(loadTargets));
    state.fileInfos = infos;
    const targets = commonTargetsFrom(infos);
    targetSelect.replaceChildren();

    if (!targets.length) {
      setSelectPlaceholder(targetSelect, "", "无共同目标格式");
      setStatus(files.length === 1
        ? "这个文件当前没有可用转换格式。"
        : "这些文件没有共同的目标格式。请分成同类型文件批量转换，或减少选择的文件。",
      "error");
      setMouseState("error");
      return;
    }

    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target;
      let label = target.toUpperCase();
      if (target === "pdf" && state.fileInfos.every((info) => info.category === "pdf")) {
        label = state.files.length > 1 ? "PDF（合并）" : "PDF（拆分为单页）";
      }
      option.textContent = label;
      targetSelect.append(option);
    }

    targetSelect.disabled = false;
    convertButton.disabled = false;
    if (files.length === 1) {
      const info = infos[0];
      setStatus(`识别为${labels[info.category] || labels.unknown}文件，可转换为：${targets.map((target) => target.toUpperCase()).join("、")}。`);
    } else {
      setStatus(`已选择 ${files.length} 个文件，共同可转换为：${targets.map((target) => target.toUpperCase()).join("、")}。`);
    }
    setMouseState(files.length > 1 ? "batch" : "idle");
    setWorkflowStep("convert");
  } catch (error) {
    setStatus(`识别失败：${error.message}`, "error");
    setMouseState("error");
    setWorkflowStep("analyze");
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function convertOneFile(file, targetFormat) {
  const form = new FormData();
  form.append("file", file);
  form.append("targetFormat", targetFormat);

  const response = await fetch("/api/convert", {
    method: "POST",
    body: form
  });
  const result = await parseResponse(response);

  if (!response.ok) {
    throw new Error(result.error || `服务器返回 ${response.status}`);
  }
  return result;
}

function isMergedImagePdfConversion(targetFormat) {
  return targetFormat === "pdf"
    && state.files.length > 1
    && state.fileInfos.length === state.files.length
    && state.fileInfos.every((info) => info.category === "image");
}

async function convertImagesToPdf(files) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }

  const response = await fetch("/api/convert-images-to-pdf", {
    method: "POST",
    body: form
  });
  const result = await parseResponse(response);

  if (!response.ok) {
    throw new Error(result.error || `服务器返回 ${response.status}`);
  }
  return result;
}

async function convertMergedImagesToPdf() {
  state.files.forEach((_file, index) => {
    setBatchResult(index, { status: "converting", detail: "正在合并到 PDF" });
  });
  setProgress(35, "正在合并图片");

  try {
    const result = await convertImagesToPdf(state.files);
    state.batchResults = state.files.map((_file, index) => ({
      status: "success",
      detail: index === 0 ? result.fileName : `已合并到 ${result.fileName}`,
      result: index === 0 ? result : null
    }));
    renderBatchList();
    state.converted = result;
    downloadButton.href = result.downloadUrl;
    downloadButton.download = result.fileName;
    downloadButton.textContent = `保存 ${result.fileName}`;
    downloadButton.hidden = false;
    batchSaveButton.hidden = true;
    setProgress(100, "合并完成", "success");
    setStatus(`图片已合并为：${result.fileName}。`, "success");
    setMouseState("success");
    setWorkflowStep("save");
  } catch (error) {
    state.batchResults = state.files.map(() => ({
      status: "error",
      detail: error.message || "合并 PDF 失败"
    }));
    renderBatchList();
    setProgress(100, "合并失败", "error");
    setStatus(`合并 PDF 失败：${error.message || "未知错误"}`, "error");
    setMouseState("error");
  } finally {
    state.isConverting = false;
    convertButton.disabled = !state.files.length;
    targetSelect.disabled = !state.files.length;
  }
}

function isMergedPdfConversion(targetFormat) {
  return targetFormat === "pdf"
    && state.files.length > 1
    && state.fileInfos.length === state.files.length
    && state.fileInfos.every((info) => info.category === "pdf");
}

function isSplitPdfConversion(targetFormat) {
  return targetFormat === "pdf"
    && state.files.length === 1
    && state.fileInfos.length === 1
    && state.fileInfos[0].category === "pdf";
}

async function convertPdfsToMerged(files) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }

  const response = await fetch("/api/merge-pdfs", {
    method: "POST",
    body: form
  });
  const result = await parseResponse(response);

  if (!response.ok) {
    throw new Error(result.error || `服务器返回 ${response.status}`);
  }
  return result;
}

async function convertMergedPdfs() {
  state.files.forEach((_file, index) => {
    setBatchResult(index, { status: "converting", detail: "正在合并到 PDF" });
  });
  setProgress(35, "正在合并 PDF");

  try {
    const result = await convertPdfsToMerged(state.files);
    state.batchResults = state.files.map((_file, index) => ({
      status: "success",
      detail: index === 0 ? result.fileName : `已合并到 ${result.fileName}`,
      result: index === 0 ? result : null
    }));
    renderBatchList();
    state.converted = result;
    downloadButton.href = result.downloadUrl;
    downloadButton.download = result.fileName;
    downloadButton.textContent = `保存 ${result.fileName}`;
    downloadButton.hidden = false;
    batchSaveButton.hidden = true;
    setProgress(100, "合并完成", "success");
    setStatus(`PDF 已合并为：${result.fileName}。`, "success");
    setMouseState("success");
    setWorkflowStep("save");
  } catch (error) {
    state.batchResults = state.files.map(() => ({
      status: "error",
      detail: error.message || "合并 PDF 失败"
    }));
    renderBatchList();
    setProgress(100, "合并失败", "error");
    setStatus(`合并 PDF 失败：${error.message || "未知错误"}`, "error");
    setMouseState("error");
  } finally {
    state.isConverting = false;
    convertButton.disabled = !state.files.length;
    targetSelect.disabled = !state.files.length;
  }
}

async function convertCurrentFiles() {
  if (!state.files.length || !targetSelect.value || state.isConverting) return;

  const targetFormat = targetSelect.value;
  state.isConverting = true;
  convertButton.disabled = true;
  targetSelect.disabled = true;
  resetDownload();
  state.batchResults = state.files.map(() => ({ status: "pending", detail: "等待转换" }));
  renderBatchList();
  setProgress(0, "准备转换");
  setMouseState("converting");
  const conversionMouseState = mouseStateForConversion(targetFormat);
  if (conversionMouseState !== "converting") {
    setMouseState(conversionMouseState);
  }
  setWorkflowStep("convert");
  setStatus(state.files.length === 1
    ? "正在转换，请稍等。PDF、Office/WPS 或视频文件可能需要更久..."
    : `正在批量转换 ${state.files.length} 个文件，请稍等...`);

  if (isMergedImagePdfConversion(targetFormat)) {
    await convertMergedImagesToPdf();
    return;
  }

  if (isMergedPdfConversion(targetFormat)) {
    await convertMergedPdfs();
    return;
  }

  if (isSplitPdfConversion(targetFormat)) {
    setStatus("正在把 PDF 拆分为单页文件...");
  }

  let successCount = 0;
  let failCount = 0;

  for (let index = 0; index < state.files.length; index += 1) {
    const file = state.files[index];
    setBatchResult(index, { status: "converting", detail: `正在转换为 ${targetFormat.toUpperCase()}` });
    setProgress((index / state.files.length) * 100, `正在转换 ${index + 1}/${state.files.length}`);

    try {
      const result = await convertOneFile(file, targetFormat);
      successCount += 1;
      setBatchResult(index, { status: "success", detail: result.fileName, result });
    } catch (error) {
      failCount += 1;
      setBatchResult(index, { status: "error", detail: error.message || "未知错误" });
    }
  }

  const completed = successCount + failCount;
  const type = failCount ? (successCount ? "" : "error") : "success";
  setProgress(100, failCount ? `完成 ${completed}/${state.files.length}，失败 ${failCount} 个` : "转换完成", type);

  state.batchResults = [...state.batchResults];
  const successful = state.batchResults.filter((item) => item.status === "success" && item.result);
  state.converted = successful.length === 1 ? successful[0].result : null;

  if (successful.length === 1) {
    downloadButton.href = successful[0].result.downloadUrl;
    downloadButton.download = successful[0].result.fileName;
    downloadButton.textContent = `保存 ${successful[0].result.fileName}`;
    downloadButton.hidden = false;
  }

  batchSaveButton.hidden = successful.length < 2;
  setMouseState(failCount ? "error" : "success");
  if (successful.length) {
    setWorkflowStep("save");
  }
  setStatus(failCount
    ? `批量转换完成：成功 ${successCount} 个，失败 ${failCount} 个。失败原因已显示在对应文件旁边。`
    : `批量转换完成：成功 ${successCount} 个。`,
  failCount ? (successCount ? "" : "error") : "success");

  state.isConverting = false;
  convertButton.disabled = !state.files.length;
  targetSelect.disabled = !state.files.length;
}

async function saveResult(result) {
  if (!result) return;

  if (window.flyingMouseFormat?.saveConvertedFile) {
    setStatus(`请选择 ${result.fileName} 的保存位置...`);
    const saved = await window.flyingMouseFormat.saveConvertedFile({
      downloadUrl: result.downloadUrl,
      fileName: result.fileName
    });
    if (saved?.canceled) {
      setStatus(`转换完成：${result.fileName}。尚未保存。`, "success");
      return;
    }
    setStatus(`已保存到：${saved.filePath}`, "success");
    return;
  }

  const link = document.createElement("a");
  link.href = result.downloadUrl;
  link.download = result.fileName;
  link.click();
}

async function saveConvertedFile(event) {
  if (!state.converted) return;
  event.preventDefault();

  try {
    await saveResult(state.converted);
  } catch (error) {
    setStatus(`保存失败：${error.message || "未知错误"}`, "error");
  }
}

async function saveAllConvertedFiles() {
  const results = state.batchResults
    .filter((item) => item.status === "success" && item.result)
    .map((item) => item.result);
  if (!results.length) return;

  try {
    if (window.flyingMouseFormat?.saveConvertedFiles) {
      setStatus(`请选择 ${results.length} 个文件的保存文件夹...`);
      const saved = await window.flyingMouseFormat.saveConvertedFiles({ files: results });
      if (saved?.canceled) {
        setStatus(`已转换 ${results.length} 个文件，尚未保存。`, "success");
        return;
      }
      setStatus(`已保存 ${saved.savedCount} 个文件到：${saved.directory}`, "success");
      return;
    }

    for (const result of results) {
      const link = document.createElement("a");
      link.href = result.downloadUrl;
      link.download = result.fileName;
      link.click();
    }
  } catch (error) {
    setStatus(`保存全部失败：${error.message || "未知错误"}`, "error");
  }
}

dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
  setMouseState("upload");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
  setMouseState(state.files.length > 1 ? "batch" : state.files.length ? "idle" : "upload");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  acceptFiles(event.dataTransfer.files);
});

fileInput.addEventListener("change", () => {
  acceptFiles(fileInput.files);
});

batchList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-save-index]");
  if (!button) return;
  const index = Number(button.dataset.saveIndex);
  const result = state.batchResults[index]?.result;
  try {
    await saveResult(result);
  } catch (error) {
    setStatus(`保存失败：${error.message || "未知错误"}`, "error");
  }
});

clearButton.addEventListener("click", clearFile);
convertButton.addEventListener("click", convertCurrentFiles);
downloadButton.addEventListener("click", saveConvertedFile);
batchSaveButton.addEventListener("click", saveAllConvertedFiles);

fetchCapabilities().catch((error) => {
  toolHealth.textContent = "检测失败";
  setStatus(error.message, "error");
  setMouseState("error");
});

setMouseState("upload");
setWorkflowStep("select");
