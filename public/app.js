const state = {
  files: [],
  fileInfos: [],
  capabilities: null,
  converted: null,
  batchResults: [],
  isConverting: false,
  progressValue: 0,
  previewResult: null,
  previewOpener: null,
  folderName: "",
  settings: { schemaVersion: 2, targetBySource: {} }
};

/* --- 渲染进程日志：转发到主进程 debug.log --- */
const logBridge = window.flyingMouseFormat || {};

function rendererLog(level, message, error) {
  const detail = error ? `${message}\n${error.stack || error.message || error}` : message;
  try {
    if (typeof logBridge.log === "function") {
      logBridge.log(level, detail).catch(() => {});
    } else {
      // 非桌面环境（纯浏览器预览）退化为 console
      if (level === "error") console.error(detail);
      else if (level === "warn") console.warn(detail);
      else console.info(detail);
    }
  } catch {
    // 日志转发失败不应影响功能
  }
}

window.addEventListener("error", (event) => {
  rendererLog("error", `未捕获的渲染进程错误: ${event.message || "unknown"}`, event.error);
});

window.addEventListener("unhandledrejection", (event) => {
  rendererLog("error", "未处理的 Promise 拒绝", event.reason);
});

const fileInput = document.querySelector("#fileInput");
const folderInput = document.querySelector("#folderInput");
const chooseFolderButton = document.querySelector("#chooseFolderButton");
const dropZone = document.querySelector("#dropZone");
const fileStrip = document.querySelector("#fileStrip");
const fileName = document.querySelector("#fileName");
const fileMeta = document.querySelector("#fileMeta");
const targetSelect = document.querySelector("#targetSelect");
const pdfExcelHint = document.querySelector("#pdfExcelHint");
const zipCompressionField = document.querySelector("#zipCompressionField");
const zipCompression = document.querySelector("#zipCompression");
const videoCodecField = document.querySelector("#videoCodecField");
const videoCodec = document.querySelector("#videoCodec");
const alphaBackgroundField = document.querySelector("#alphaBackgroundField");
const alphaBackground = document.querySelector("#alphaBackground");
const pdfPasswordField = document.querySelector("#pdfPasswordField");
const pdfPassword = document.querySelector("#pdfPassword");
const pdfActionField = document.querySelector("#pdfActionField");
const pdfAction = document.querySelector("#pdfAction");
const pdfSplitModeField = document.querySelector("#pdfSplitModeField");
const pdfSplitMode = document.querySelector("#pdfSplitMode");
const pdfGroupSizeField = document.querySelector("#pdfGroupSizeField");
const pdfGroupSize = document.querySelector("#pdfGroupSize");
const convertButton = document.querySelector("#convertButton");
const clearButton = document.querySelector("#clearButton");
const statusBox = document.querySelector("#statusBox");
const downloadButton = document.querySelector("#downloadButton");
const batchSaveButton = document.querySelector("#batchSaveButton");
const previewButton = document.querySelector("#previewButton");
const previewDrawer = document.querySelector("#previewDrawer");
const previewBackdrop = document.querySelector("#previewBackdrop");
const previewClose = document.querySelector("#previewClose");
const previewTitle = document.querySelector("#previewTitle");
const previewMeta = document.querySelector("#previewMeta");
const previewContent = document.querySelector("#previewContent");
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
const languageSelect = document.querySelector("#languageSelect");
const diagnosticsButton = document.querySelector("#diagnosticsButton");
const compressFolderButton = document.querySelector("#compressFolderButton");
const agentInstallButton = document.querySelector("#agentInstallButton");
const workflowSteps = [...document.querySelectorAll("[data-step]")];
const {
  STORAGE_KEY: LEGACY_TARGET_STORAGE_KEY,
  readPreferences,
  rememberTarget,
  preferredTarget
} = window.FlyingMouseConversionPreferences;
const { LANGUAGE_STORAGE_KEY, createI18n } = window.FlyingMouseI18n;

const messages = {
  "zh-CN": {
    "workspace.aria": "文件转换工作台", "brand.title": "鼠鼠帮你把文件转成需要的格式",
    "language.label": "语言", "health.checking": "正在检测转换引擎", "health.failed": "检测失败",
    "diagnostics.export": "导出诊断", "diagnostics.saved": "诊断报告已保存到：{path}",
    "diagnostics.canceled": "已取消导出诊断报告。", "diagnostics.failed": "导出诊断失败：{message}",
    "agent.install": "接入 Agent", "agent.checking": "正在检索已安装 Agent 的 skill 目录…",
    "agent.none": "没有发现现有的 Agent skill 目录。请先安装 Codex、Claude 或创建 ~/.agents/skills。",
    "agent.canceled": "已取消接入 Agent。", "agent.installed": "已接入 {count} 个 Agent：{paths}",
    "agent.partial": "已接入 {count} 个 Agent，另有 {failed} 个失败：{message}", "agent.failed": "接入 Agent 失败：{message}",
    "preview.open": "预览", "preview.eyebrow": "转换结果", "preview.title": "文件预览",
    "preview.close": "关闭预览", "preview.loading": "正在载入预览…", "preview.unsupported": "此格式暂不支持内嵌预览，可以保存后使用系统应用打开。",
    "preview.tooLarge": "文本文件超过 2 MB，为避免界面卡顿，请保存后查看。", "preview.failed": "预览失败：{message}",
    "update.check": "检查更新", "update.checking": "正在检查更新…",
    "update.latest": "已是最新版本", "update.available": "发现新版本 v{version}，正在下载…",
    "update.downloaded": "新版本 v{version} 已下载，重启后生效", "update.restart": "立即重启",
    "update.error": "更新检查失败：{message}", "update.unavailable": "当前版本不支持自动更新",
    "workflow.aria": "转换流程", "workflow.select": "选择文件", "workflow.analyze": "识别格式",
    "workflow.convert": "开始转换", "workflow.save": "保存结果", "upload.aria": "上传文件",
    "upload.title": "把文件丢给鼠鼠", "upload.hint": "图片、文档、PDF、WPS、音视频都可以试", "upload.chooseFolder": "选择文件夹转 PDF",
    "upload.limited": "PDF 表格可以转 Excel；Office/WPS 需要内置 LibreOffice",
    "action.clear": "清空", "action.convert": "开始转换", "action.download": "下载转换后的文件",
    "action.save": "保存", "action.saveAll": "保存全部", "action.compressFolder": "压缩文件夹",
    "compressFolder.saved": "已压缩 {count} 个文件到：{path}",
    "compressFolder.canceled": "已取消压缩文件夹。", "compressFolder.failed": "压缩文件夹失败：{message}",
    "target.label": "目标格式",
    "target.placeholder": "先选择文件", "target.analyzing": "正在识别", "target.none": "无共同目标格式",
    "pdfExcel.hint": "适合电子版规则表格；扫描件、复杂表头和合并单元格可能不完整。",
    "formats.experimental": "实验性/尚未完整验证的输入：{formats}",
    "formats.av3aMac": "macOS 支持标准 NCM；Audio Vivid AV3A 目前仅支持 Windows。",
    "zip.label": "ZIP 压缩级别（0=不压缩，9=最大）", "zip.0": "0 不压缩（最快）",
    "zip.1": "1 最快", "zip.6": "6 标准（默认）", "zip.9": "9 最大压缩（最慢）",
    "videoCodec.label": "视频编码", "videoCodec.h264": "H.264（兼容性最好，默认）",
    "videoCodec.h265": "H.265（体积更小）", "videoCodec.av1": "AV1（压缩率最高）",
    "alphaBackground.label": "透明背景色（带透明通道的视频转码时合成）",
    "alphaBackground.white": "白色（默认）", "alphaBackground.black": "黑色",
    "alphaBackground.green": "绿色（绿幕）", "alphaBackground.magenta": "洋红（绿幕抠像常用）",
    "pdfPassword.label": "PDF 密码（加密/解密）", "pdfAction.label": "PDF 操作",
    "pdfAction.split": "拆分 PDF（默认）", "pdfAction.encrypt": "加密 PDF", "pdfAction.decrypt": "解密 PDF",
    "pdfSplitMode.label": "拆分方式", "pdfSplitMode.page": "逐页拆分（每页一个 PDF）", "pdfSplitMode.group": "每 N 页一组",
    "pdfGroupSize.label": "每几页一组",
    "settings.aria": "转换设置", "progress.label": "转换进度", "status.ready": "选择文件后会显示可用的转换格式。",
    "formats.aria": "支持格式", "formats.title": "当前支持",
    "formats.description": "文档转换会尽量保留排版；PDF 可导出页面图片，图片和扫描版 PDF 可 OCR 转 TXT。音频解锁（NCM/mflac/kgma 等）仅支持你已购买或自有的本地文件。",
    "feedback.label": "问题反馈", "feedback.hint": "如需帮助，请导出诊断报告并查看错误提示。",
    "feedback.guide": "问题反馈：转换遇到问题，请导出诊断报告并查看错误提示，帮助信息详见软件说明。",
    "tutorial.qq.title": "QQ 音乐登录教程",
    "tutorial.close": "关闭",
    "tutorial.qq.lead": "新版 QQ 音乐加密音频（musicex）的密钥存在服务器上，需要你登录 QQ 音乐的网页版凭据在线换取。请按下面步骤获取凭据，放好后重新转换即可。注意：无论你的歌是从 QQ 音乐下载的、还是从微信聊天里收到的，获取 cookie 的步骤完全一样——都是去网页版 y.qq.com 登录同一个 QQ 账号。",
    "tutorial.qq.s1.title": "① 打开网页版 QQ 音乐并登录",
    "tutorial.qq.s1.desc": "用电脑浏览器打开 y.qq.com，点右上角「登录」，用你下载歌曲的 QQ 账号登录。",
    "tutorial.qq.s1.alt": "QQ 音乐网页版登录后的页面",
    "tutorial.qq.s1.cap": "图 1：登录后的网页版 QQ 音乐",
    "tutorial.qq.s2.title": "② 打开开发者工具",
    "tutorial.qq.s2.desc": "在网页上按键盘 F12（笔记本可能需同时按 Fn），或右键 →「检查」。浏览器下方/右侧会出现开发者工具面板。",
    "tutorial.qq.s2.alt": "按 F12 后开发者工具打开",
    "tutorial.qq.s2.cap": "图 2：开发者工具面板",
    "tutorial.qq.s3.title": "③ 切到「应用程序 / Application」标签",
    "tutorial.qq.s3.desc": "在开发者工具顶部标签栏找到「Application」（中文浏览器显示为「应用程序」），点它。如果顶部没有，点 » 展开更多标签。",
    "tutorial.qq.s3.alt": "开发者工具顶部的 Application 标签",
    "tutorial.qq.s3.cap": "图 3：顶部标签栏的 Application",
    "tutorial.qq.s4.title": "④ 找到 Cookie 列表",
    "tutorial.qq.s4.desc": "在左侧菜单展开「Storage → Cookies」，点下面的 https://y.qq.com，右侧会出现这个网站的 Cookie 列表。",
    "tutorial.qq.s4.alt": "Storage → Cookies → y.qq.com 的列表",
    "tutorial.qq.s4.cap": "图 4：Cookie 列表",
    "tutorial.qq.s5.title": "⑤ 复制 qm_keyst 和 uin",
    "tutorial.qq.s5.desc": "在列表里找到 qm_keyst（新版登录可能显示为 psrf_qqmusic_key）这一行，双击它的「值 / Value」列，Ctrl+C 复制整串内容。再找到 uin 行，复制你的 QQ 号。两个值都要复制。",
    "tutorial.qq.s5.alt": "qm_keyst 和 uin 两行 Cookie",
    "tutorial.qq.s5.cap": "图 5：qm_keyst 与 uin",
    "tutorial.qq.s6.title": "⑥ 在桌面新建 cookie 文件",
    "tutorial.qq.s6.desc": "在桌面空白处点鼠标右键 →「新建」→「文本文档」，把文件名改成 QQ音乐_登录cookie.txt（保留 .txt 后缀）。双击打开，点下面的「复制模板」，到记事本里粘贴，把「你的QQ号」和「你复制的qm_keyst值」替换成你自己的，然后 Ctrl+S 保存。位置说明：文件直接放在你的桌面就行，软件会自动识别你当前的桌面位置（无论桌面在 C 盘、D 盘，还是被 OneDrive 同步）。如果转换仍提示需要凭据，请把文件再复制一份到「C:\\Users\\你的用户名\\Desktop」这个文件夹里。",
    "tutorial.qq.s6.alt": "记事本里 cookie 文件的格式",
    "tutorial.qq.s6.cap": "图 6：cookie 文件内容格式",
    "tutorial.copyTemplate": "复制模板",
    "tutorial.copied": "模板已复制，粘贴到记事本后替换成你的信息",
    "tutorial.qq.s7.title": "⑦ 回到鼠鼠重新转换",
    "tutorial.qq.s7.desc": "文件放好后，回到本软件重新拖入那个加密音频转换即可。cookie 偶尔会过期，提示需要凭据时重复上面的步骤更新一次就好。",
    "tutorial.gotIt": "我知道了",
    "sponsor.aria": "支持鼠鼠", "sponsor.close": "收起", "sponsor.title": "请鼠鼠吃小鱼干 🐟",
    "sponsor.description": "本软件永久免费。如果帮到了你，欢迎请鼠鼠吃根小鱼干～纯自愿。若有人收费售卖本软件，那一定是套壳圈钱的骗子，请勿上当。",
    "sponsor.qrAlt": "微信收款码"
  },
  "en-US": {
    "workspace.aria": "File conversion workspace", "brand.title": "Let Mouse convert files into the format you need",
    "language.label": "Language", "health.checking": "Checking conversion engines", "health.failed": "Check failed",
    "diagnostics.export": "Export diagnostics", "diagnostics.saved": "Diagnostics saved to: {path}",
    "diagnostics.canceled": "Diagnostics export canceled.", "diagnostics.failed": "Diagnostics export failed: {message}",
    "agent.install": "Connect to Agent", "agent.checking": "Looking for existing Agent skill directories…",
    "agent.none": "No existing Agent skill directory was found. Install Codex or Claude, or create ~/.agents/skills first.",
    "agent.canceled": "Agent connection canceled.", "agent.installed": "Connected to {count} Agent target(s): {paths}",
    "agent.partial": "Connected to {count} target(s); {failed} failed: {message}", "agent.failed": "Agent connection failed: {message}",
    "preview.open": "Preview", "preview.eyebrow": "Conversion result", "preview.title": "File preview",
    "preview.close": "Close preview", "preview.loading": "Loading preview…", "preview.unsupported": "This format cannot be previewed here. Save it and open it with a system application.",
    "preview.tooLarge": "This text file is larger than 2 MB. Save it to view without slowing the app.", "preview.failed": "Preview failed: {message}",
    "update.check": "Check for Updates", "update.checking": "Checking for updates…",
    "update.latest": "You are up to date", "update.available": "New version v{version} found, downloading…",
    "update.downloaded": "v{version} downloaded; restart to apply", "update.restart": "Restart now",
    "update.error": "Update check failed: {message}", "update.unavailable": "Auto-update is unavailable in this build",
    "workflow.aria": "Conversion workflow", "workflow.select": "Select files", "workflow.analyze": "Detect format",
    "workflow.convert": "Convert", "workflow.save": "Save results", "upload.aria": "Upload files",
    "upload.title": "Drop files to Mouse", "upload.hint": "Try images, documents, PDF, WPS, audio, or video", "upload.chooseFolder": "Choose folder → PDF",
    "upload.limited": "PDF tables can be converted to Excel; Office/WPS needs bundled LibreOffice",
    "action.clear": "Clear", "action.convert": "Convert", "action.download": "Download converted file",
    "action.save": "Save", "action.saveAll": "Save all", "action.compressFolder": "Compress folder",
    "compressFolder.saved": "Compressed {count} files to: {path}",
    "compressFolder.canceled": "Folder compression canceled.", "compressFolder.failed": "Folder compression failed: {message}",
    "target.label": "Target format",
    "target.placeholder": "Select files first", "target.analyzing": "Detecting", "target.none": "No common target format",
    "pdfExcel.hint": "Best for digital PDFs with regular tables. Scans, complex headers, and merged cells may be incomplete.",
    "formats.experimental": "Experimental/unverified inputs: {formats}",
    "formats.av3aMac": "Standard NCM works on macOS; Audio Vivid AV3A currently requires Windows.",
    "zip.label": "ZIP compression level (0=none, 9=maximum)", "zip.0": "0 None (fastest)",
    "zip.1": "1 Fastest", "zip.6": "6 Standard (default)", "zip.9": "9 Maximum (slowest)",
    "videoCodec.label": "Video codec", "videoCodec.h264": "H.264 (best compatibility, default)",
    "videoCodec.h265": "H.265 (smaller size)", "videoCodec.av1": "AV1 (highest compression)",
    "alphaBackground.label": "Transparent background (composited when transcoding videos with alpha)",
    "alphaBackground.white": "White (default)", "alphaBackground.black": "Black",
    "alphaBackground.green": "Green (green screen)", "alphaBackground.magenta": "Magenta (common for chroma key)",
    "pdfPassword.label": "PDF password (encrypt/decrypt)", "pdfAction.label": "PDF action",
    "pdfAction.split": "Split PDF (default)", "pdfAction.encrypt": "Encrypt PDF", "pdfAction.decrypt": "Decrypt PDF",
    "pdfSplitMode.label": "Split mode", "pdfSplitMode.page": "Split into single pages", "pdfSplitMode.group": "Group every N pages",
    "pdfGroupSize.label": "Pages per group",
    "settings.aria": "Conversion settings", "progress.label": "Conversion progress", "status.ready": "Available target formats appear after you select files.",
    "formats.aria": "Supported formats", "formats.title": "Supported now",
    "formats.description": "Document conversion preserves layout where possible; PDFs can export page images, and images and scanned PDFs can be OCRed to TXT. Audio unlock (NCM/mflac/kgma etc.) only supports local files you own or have purchased.",
    "feedback.label": "Feedback", "feedback.hint": "For help, export the diagnostics report and check the error details.",
    "feedback.guide": "Feedback: if a conversion fails, export the diagnostics report and check the error details. Help is described in the app documentation.",
    "tutorial.qq.title": "QQ Music Login Guide",
    "tutorial.close": "Close",
    "tutorial.qq.lead": "New QQ Music encrypted audio (musicex) keeps its key on the server; it must be fetched online using your QQ Music web login credentials. Follow the steps below, place the credential file, then convert again. Note: whether your song came from QQ Music or was received in WeChat, the steps are identical — just sign in to y.qq.com with the same QQ account.",
    "tutorial.qq.s1.title": "① Open QQ Music web and sign in",
    "tutorial.qq.s1.desc": "Open y.qq.com in your computer browser, click \"Sign in\" at the top right, and log in with the QQ account you used to download the song.",
    "tutorial.qq.s1.alt": "QQ Music web page after signing in",
    "tutorial.qq.s1.cap": "Fig. 1: QQ Music web after sign-in",
    "tutorial.qq.s2.title": "② Open Developer Tools",
    "tutorial.qq.s2.desc": "Press F12 on the page (Fn+F12 on some laptops), or right-click → \"Inspect\". The developer tools panel opens at the bottom or right side.",
    "tutorial.qq.s2.alt": "Developer Tools opened after pressing F12",
    "tutorial.qq.s2.cap": "Fig. 2: Developer Tools panel",
    "tutorial.qq.s3.title": "③ Switch to the \"Application\" tab",
    "tutorial.qq.s3.desc": "In the developer tools top tab bar, click \"Application\" (shown as 应用程序 in Chinese browsers). If it is hidden, click » to reveal more tabs.",
    "tutorial.qq.s3.alt": "Application tab in the developer tools tab bar",
    "tutorial.qq.s3.cap": "Fig. 3: Application tab",
    "tutorial.qq.s4.title": "④ Open the Cookie list",
    "tutorial.qq.s4.desc": "In the left menu expand \"Storage → Cookies\" and click https://y.qq.com below it. The cookie list for this site appears on the right.",
    "tutorial.qq.s4.alt": "Storage → Cookies → y.qq.com list",
    "tutorial.qq.s4.cap": "Fig. 4: Cookie list",
    "tutorial.qq.s5.title": "⑤ Copy qm_keyst and uin",
    "tutorial.qq.s5.desc": "Find the qm_keyst row (newer sign-ins may show it as psrf_qqmusic_key), double-click its Value column, press Ctrl+C to copy the whole string. Then find the uin row and copy your QQ number. Copy both values.",
    "tutorial.qq.s5.alt": "qm_keyst and uin cookie rows",
    "tutorial.qq.s5.cap": "Fig. 5: qm_keyst and uin",
    "tutorial.qq.s6.title": "⑥ Create the cookie file on your desktop",
    "tutorial.qq.s6.desc": "Right-click an empty area of your desktop → \"New\" → \"Text Document\", rename it to QQ音乐_登录cookie.txt (keep the .txt extension). Double-click to open it, click \"Copy template\" below, paste into Notepad, replace \"your QQ number\" and \"the qm_keyst value you copied\" with your own, then press Ctrl+S to save. Location: just place the file on your desktop — the app auto-detects your real desktop folder (whether it's on the C: drive, D: drive, or synced by OneDrive). If conversion still says credentials are needed, also copy the file to \"C:\\Users\\<your username>\\Desktop\".",
    "tutorial.qq.s6.alt": "Cookie file format in Notepad",
    "tutorial.qq.s6.cap": "Fig. 6: Cookie file content format",
    "tutorial.copyTemplate": "Copy template",
    "tutorial.copied": "Template copied. Paste it into Notepad and replace the placeholders with your info.",
    "tutorial.qq.s7.title": "⑦ Convert again in Mouse",
    "tutorial.qq.s7.desc": "Once the file is in place, drag the encrypted audio into this app and convert again. The cookie expires occasionally; when credentials are requested again, repeat the steps above to refresh it.",
    "tutorial.gotIt": "Got it",
    "sponsor.aria": "Support Mouse", "sponsor.close": "Close", "sponsor.title": "Buy Mouse a dried fish 🐟",
    "sponsor.description": "This app is permanently free. If it helped you, you can buy Mouse a snack - completely optional. If anyone charges you for this app, it's a scam.",
    "sponsor.qrAlt": "WeChat payment QR code"
  }
};

const i18n = createI18n({ storage: localStorage, systemLanguage: navigator.language, messages });
const t = (key, params) => i18n.t(key, params);

function applyStaticTranslations() {
  document.documentElement.lang = i18n.language;
  languageSelect.value = i18n.language;
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-aria]")) element.setAttribute("aria-label", t(element.dataset.i18nAria));
  for (const element of document.querySelectorAll("[data-i18n-title]")) element.title = t(element.dataset.i18nTitle);
  for (const element of document.querySelectorAll("[data-i18n-alt]")) element.alt = t(element.dataset.i18nAlt);
}

function renderHealth() {
  if (!state.capabilities) return;
  const enabled = i18n.language === "en-US" ? ["Images", "Text", "PDF", "ZIP"] : ["图片", "文本", "PDF", "ZIP"];
  if (state.capabilities.tools.libreoffice) enabled.push("Office/WPS");
  if (state.capabilities.tools.ffmpeg) enabled.push(i18n.language === "en-US" ? "Audio/Video" : "音视频");
  toolHealth.textContent = i18n.language === "en-US" ? `${enabled.join(", ")} enabled` : `${enabled.join("、")} 已启用`;
  if (!state.capabilities.tools.libreoffice) dropHint.textContent = t("upload.limited");
}

function refreshLanguage() {
  applyStaticTranslations();
  renderHealth();
  if (state.capabilities) renderFormatTable();
  if (!state.files.length) setStatus(t("status.ready"));
  resetProgress();
  renderBatchList();
  syncPdfExcelHint();
}

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

const englishLabels = {
  image: "Image", text: "Text", document: "Word/WPS document", spreadsheet: "Excel/WPS spreadsheet",
  presentation: "PPT/WPS presentation", pdf: "PDF", audio: "Audio", video: "Video", any: "Any file", unknown: "Unknown type"
};
const englishStatusLabels = { pending: "Waiting", converting: "Converting", success: "Complete", error: "Failed" };
const categoryLabel = (key) => i18n.language === "en-US" ? (englishLabels[key] || englishLabels.unknown) : (labels[key] || labels.unknown);
const batchStatusLabel = (key) => i18n.language === "en-US" ? (englishStatusLabels[key] || "Waiting") : (statusLabels[key] || statusLabels.pending);

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
  mouseMascot.src = mouseAssets[name] || mouseAssets.idle;
  mouseMascot.dataset.state = name;
}

function setWorkflowStep(step) {
  for (const item of workflowSteps) {
    item.classList.toggle("active", item.dataset.step === step);
  }
}

function mouseStateForConversion(targetFormat) {
  if (state.files.length > 1) return "batch";
  if (targetFormat === "txt" && state.fileInfos.some((info) => info.category === "image" || info.category === "pdf")) return "ocr";
  if ((targetFormat === "png" || targetFormat === "jpg") && state.fileInfos.some((info) => info.category === "pdf")) return "pdfPages";
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

// 不确定进度（单文件长任务：视频/PDF/Office 转码无实时进度，进度条滑动动画代替死板的 0%）
function setIndeterminateProgress(label) {
  state.progressValue = 0;
  progressPanel.hidden = false;
  progressPanel.className = "progress-panel indeterminate";
  progressLabel.textContent = label;
  progressPercent.textContent = "";
  progressFill.style.width = "";
  progressTrack.setAttribute("aria-valuenow", "0");
}

// 长任务目标：转码/转换耗时较长（视频编码、PDF/Office 经 LibreOffice/docengine），无实时进度。
const LONG_TASK_TARGETS = new Set([
  "mp4", "mov", "mkv", "webm", "gif",
  "pdf", "docx", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "odp"
]);

function isLongTaskTarget(target) {
  return LONG_TASK_TARGETS.has(String(target || "").toLowerCase());
}

function longTaskProgressLabel(target) {
  const fmt = String(target || "").toLowerCase();
  if (["mp4", "mov", "mkv", "webm", "gif"].includes(fmt)) {
    return i18n.language === "en-US"
      ? "Transcoding video — this can take a few minutes, please wait…"
      : "正在转码视频，可能需要几分钟，请耐心等待…";
  }
  if (fmt === "pdf") {
    return i18n.language === "en-US"
      ? "Converting to PDF — this can take a while, please wait…"
      : "正在转换为 PDF，可能需要一点时间，请耐心等待…";
  }
  return i18n.language === "en-US"
    ? "Converting document — this can take a while, please wait…"
    : "正在转换文档，可能需要一点时间，请耐心等待…";
}

function resetProgress() {
  state.progressValue = 0;
  progressPanel.hidden = true;
  progressPanel.className = "progress-panel";
  progressLabel.textContent = t("progress.label");
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
  previewButton.hidden = true;
  closePreview();
}

function clearFile() {
  state.files = [];
  state.fileInfos = [];
  state.isConverting = false;
  fileInput.value = "";
  fileStrip.hidden = true;
  batchList.hidden = true;
  batchList.replaceChildren();
  setSelectPlaceholder(targetSelect, "", t("target.placeholder"));
  syncPdfExcelHint();
  targetSelect.disabled = true;
  convertButton.disabled = true;
  resetDownload();
  resetProgress();
  setMouseState("upload");
  setStatus(t("status.ready"));
  setWorkflowStep("select");
}

async function fetchCapabilities() {
  const response = await fetch("/api/capabilities");
  if (!response.ok) throw new Error(i18n.language === "en-US" ? "Unable to read conversion capabilities." : "无法读取转换能力。");
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
  renderHealth();
}

function renderFormatTable() {
  const groups = state.capabilities?.groups || {};
  const pairSeparator = i18n.language === "en-US" ? ": " : "：";
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
      createTextElement("h3", "", categoryLabel(key)),
      createTextElement("p", "", `${i18n.language === "en-US" ? "Input" : "输入"}${pairSeparator}${group.inputs.join(", ")}`),
      createTextElement("p", "", `${i18n.language === "en-US" ? "Output" : "输出"}${pairSeparator}${group.targets.join(", ")}`)
    );
    if (Array.isArray(group.experimentalInputs) && group.experimentalInputs.length) {
      article.append(createTextElement("p", "format-note", t("formats.experimental", {
        formats: group.experimentalInputs.join(", ")
      })));
    }
    if (key === "audio" && state.capabilities?.platform?.av3a === false) {
      article.append(createTextElement("p", "format-note", t("formats.av3aMac")));
    }
    return article;
  });
  formatTable.replaceChildren(...entries);
}

async function loadTargets(file) {
  // 空白页占位条目：不调后端，直接返回图片→PDF 能力（仅用于图片合并 PDF）
  if (file?.isBlankPage) {
    return { extension: "", category: "image", targets: ["pdf"], experimental: false };
  }
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
      meta: `${formatSize(files[0].size)} · ${files[0].type || (i18n.language === "en-US" ? "Unknown MIME" : "未知 MIME")}`
    };
  }
  return {
    name: i18n.language === "en-US" ? `${files.length} files selected` : `已选择 ${files.length} 个文件`,
    meta: i18n.language === "en-US" ? `${formatSize(totalBytes)} total · Converted one by one` : `总大小 ${formatSize(totalBytes)} · 将按队列逐个转换`
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
      createTextElement("p", "batch-name", file.isBlankPage ? (i18n.language === "en-US" ? "Blank page" : "空白页") : file.name),
      createTextElement("p", "batch-detail", result.detail || batchStatusLabel(result.status))
    );

    const actions = document.createElement("div");
    actions.className = "batch-actions";
    if (canReorderImages()) {
      const upButton = createTextElement("button", "mini-button", i18n.language === "en-US" ? "↑" : "↑");
      upButton.type = "button";
      upButton.dataset.move = String(index);
      upButton.dataset.direction = "up";
      upButton.disabled = index === 0;
      upButton.title = i18n.language === "en-US" ? "Move up (earlier in PDF)" : "上移（在 PDF 中更靠前）";
      const downButton = createTextElement("button", "mini-button", "↓");
      downButton.type = "button";
      downButton.dataset.move = String(index);
      downButton.dataset.direction = "down";
      downButton.disabled = index === state.files.length - 1;
      downButton.title = i18n.language === "en-US" ? "Move down (later in PDF)" : "下移（在 PDF 中更靠后）";
      actions.append(upButton, downButton);
      // 插入空白页：在该条目后面插入一页纯白 A4 页（图片合并 PDF 专用）
      const blankButton = createTextElement("button", "mini-button", i18n.language === "en-US" ? "□+" : "□+");
      blankButton.type = "button";
      blankButton.dataset.insertBlank = String(index);
      blankButton.title = i18n.language === "en-US" ? "Insert blank page after this item" : "在此项后插入空白页";
      actions.append(blankButton);
      // 空白页条目支持删除
      if (file.isBlankPage) {
        const removeBlank = createTextElement("button", "mini-button", "✕");
        removeBlank.type = "button";
        removeBlank.dataset.removeBlank = String(index);
        removeBlank.title = i18n.language === "en-US" ? "Remove blank page" : "删除空白页";
        actions.append(removeBlank);
      }
    }
    actions.append(createTextElement("span", "batch-status", batchStatusLabel(result.status)));
    if (result.status === "success" && result.result) {
      const resultPreviewButton = createTextElement("button", "mini-button", t("preview.open"));
      resultPreviewButton.type = "button";
      resultPreviewButton.dataset.previewIndex = String(index);
      actions.append(resultPreviewButton);
      const saveButton = createTextElement("button", "mini-button", t("action.save"));
      saveButton.type = "button";
      saveButton.dataset.saveIndex = String(index);
      actions.append(saveButton);
    }

    article.append(main, actions);
    return article;
  });
  batchList.replaceChildren(...entries);
}

// 多张图片合并 PDF 时允许调整顺序（PDF 页序 = 队列顺序）
function canReorderImages() {
  return isMergedImagePdfConversion(targetSelect.value)
    && !state.isConverting
    && state.batchResults.every((result) => result.status !== "success");
}

function moveFileInQueue(index, direction) {
  if (!canReorderImages()) return;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= state.files.length) return;
  const swap = (array) => {
    const tmp = array[index];
    array[index] = array[target];
    array[target] = tmp;
  };
  swap(state.files);
  swap(state.fileInfos);
  swap(state.batchResults);
  renderBatchList();
}

function setBatchResult(index, patch) {
  state.batchResults[index] = {
    ...(state.batchResults[index] || { status: "pending", detail: "等待转换" }),
    ...patch
  };
  renderBatchList();
}

function syncZipCompressionField() {
  if (!zipCompressionField || !zipCompression) return;
  zipCompressionField.hidden = targetSelect.value !== "zip";
}

function syncVideoCodecField() {
  if (!videoCodecField || !videoCodec) return;
  videoCodecField.hidden = !["mp4", "mov", "mkv"].includes(targetSelect.value);
  syncAlphaBackgroundField();
}

function syncAlphaBackgroundField() {
  if (!alphaBackgroundField || !alphaBackground) return;
  // 透明背景色只对视频目标有意义（webm 也走 alpha 合成，一并显示）。
  alphaBackgroundField.hidden = !["mp4", "mov", "mkv", "webm"].includes(targetSelect.value);
}

function syncPdfActionFields() {
  if (!pdfPasswordField || !pdfActionField) return;
  const isPdfToPdf = targetSelect.value === "pdf"
    && state.fileInfos.length === state.files.length
    && state.fileInfos.every((info) => info.category === "pdf");
  const action = pdfAction ? pdfAction.value : "";
  pdfActionField.hidden = !isPdfToPdf;
  // 密码框：仅加密/解密时显示
  pdfPasswordField.hidden = !(isPdfToPdf && (action === "encrypt" || action === "decrypt"));
  // 拆分方式：仅拆分时显示
  const isSplit = isPdfToPdf && !action;
  if (pdfSplitModeField) pdfSplitModeField.hidden = !isSplit;
  // 每 N 页：拆分 + group 时显示
  const isGroup = isSplit && pdfSplitMode && pdfSplitMode.value === "group";
  if (pdfGroupSizeField) pdfGroupSizeField.hidden = !isGroup;
}

function syncPdfExcelHint() {
  if (!pdfExcelHint) return;
  pdfExcelHint.hidden = !(targetSelect.value === "xlsx"
    && state.fileInfos.length > 0
    && state.fileInfos.every((info) => info.category === "pdf"));
}

async function acceptFiles(fileList) {
  const files = [...fileList].filter((file) => file && file.size >= 0);
  if (!files.length) return;
  const maxBatchBytes = state.capabilities?.limits?.maxBatchBytes || Number.MAX_SAFE_INTEGER;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBatchBytes) {
    setStatus(i18n.language === "en-US"
      ? "This batch is too large for this computer. Convert the files in smaller batches."
      : "本批文件总大小超出当前电脑可处理范围，请分批转换。", "error");
    setMouseState("error");
    fileInput.value = "";
    return;
  }

  state.files = files;
  state.fileInfos = [];
  state.batchResults = files.map(() => ({ status: "pending", detail: "等待转换" }));
  // 文件夹名：来自 <input webkitdirectory> 或拖入文件夹时 File.webkitRelativePath
  // 的第一个路径段（如 "相册2026/001.jpg" -> "相册2026"），用于图片合并 PDF 命名。
  const firstRel = files.find((file) => file.webkitRelativePath);
  const folderName = firstRel ? firstRel.webkitRelativePath.split("/")[0] : "";
  state.folderName = folderName && folderName !== firstRel.webkitRelativePath ? folderName : "";
  resetDownload();
  resetProgress();
  setMouseState(files.length > 1 ? "batch" : "analyzing");
  setWorkflowStep("analyze");

  const summary = summarizeFiles(files);
  fileName.textContent = summary.name;
  fileMeta.textContent = summary.meta;
  fileStrip.hidden = false;
  renderBatchList();

  targetSelect.disabled = true;
  convertButton.disabled = true;
  setSelectPlaceholder(targetSelect, "", t("target.analyzing"));
  setStatus(i18n.language === "en-US"
    ? (files.length === 1 ? "Analyzing the file and available target formats..." : `Finding common targets for ${files.length} files...`)
    : (files.length === 1 ? "正在分析文件类型和可用转换格式..." : `正在分析 ${files.length} 个文件的共同转换格式...`));

  try {
    const infos = await Promise.all(files.map(loadTargets));
    state.fileInfos = infos;
    const targets = commonTargetsFrom(infos);
    targetSelect.replaceChildren();

    if (!targets.length) {
      setSelectPlaceholder(targetSelect, "", t("target.none"));
      setStatus(files.length === 1
        ? (i18n.language === "en-US" ? "No target format is available for this file." : "这个文件当前没有可用转换格式。")
        : (i18n.language === "en-US" ? "These files have no common target format. Batch files of the same type or select fewer files." : "这些文件没有共同的目标格式。请分成同类型文件批量转换，或减少选择的文件。"),
      "error");
      syncZipCompressionField();
      syncVideoCodecField();
      syncPdfActionFields();
      setMouseState("error");
      return;
    }

    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target;
      let label = target.toUpperCase();
      if (target === "pdf" && state.fileInfos.every((info) => info.category === "pdf")) {
        label = state.files.length > 1
          ? (i18n.language === "en-US" ? "PDF (merge)" : "PDF（合并）")
          : (i18n.language === "en-US" ? "PDF (split into pages)" : "PDF（拆分为单页）");
      }
      if (target === "xlsx" && state.fileInfos.every((info) => info.category === "pdf")) {
        label = i18n.language === "en-US" ? "Excel (smart table extraction)" : "Excel（智能表格提取）";
      }
      option.textContent = label;
      targetSelect.append(option);
    }

    const rememberedTarget = preferredTarget(state.settings.targetBySource, files.map((file) => extensionOf(file.name)), targets);
    if (rememberedTarget) targetSelect.value = rememberedTarget;

    targetSelect.disabled = false;
    convertButton.disabled = false;
    syncZipCompressionField();
    syncVideoCodecField();
    syncPdfActionFields();
    syncPdfExcelHint();
    setMouseState(files.length > 1 ? "batch" : "idle");
    if (files.length === 1) {
      const info = infos[0];
      setStatus(i18n.language === "en-US"
        ? `Detected ${categoryLabel(info.category)}. Available targets: ${targets.map((target) => target.toUpperCase()).join(", ")}.`
        : `识别为${categoryLabel(info.category)}文件，可转换为：${targets.map((target) => target.toUpperCase()).join("、")}。`);
    } else {
      setStatus(i18n.language === "en-US"
        ? `Selected ${files.length} files. Common targets: ${targets.map((target) => target.toUpperCase()).join(", ")}.`
        : `已选择 ${files.length} 个文件，共同可转换为：${targets.map((target) => target.toUpperCase()).join("、")}。`);
    }
    setWorkflowStep("convert");
  } catch (error) {
    setStatus(i18n.language === "en-US" ? `Detection failed: ${error.message}` : `识别失败：${error.message}`, "error");
    setWorkflowStep("analyze");
    setMouseState("error");
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

function responseErrorMessage(result, status) {
  const localized = i18n.language === "en-US" ? result?.messages?.enUS : result?.messages?.zhCN;
  return localized || result?.error || (i18n.language === "en-US" ? `Server returned ${status}` : `服务器返回 ${status}`);
}

function responseError(result, status) {
  const errorCode = result?.errorCode ? String(result.errorCode) : "";
  const message = responseErrorMessage(result, status);
  const error = new Error(errorCode ? `${message} [${errorCode}]` : message);
  error.errorCode = errorCode;
  return error;
}

function localizedWarnings(result) {
  return (Array.isArray(result?.warnings) ? result.warnings : []).map((warning) => {
    const localized = i18n.language === "en-US" ? warning?.messages?.enUS : warning?.messages?.zhCN;
    return localized || warning?.code || "";
  }).filter(Boolean);
}

async function convertOneFile(file, targetFormat) {
  const form = new FormData();
  form.append("file", file);
  form.append("targetFormat", targetFormat);
  if (targetFormat === "zip") {
    form.append("compressionLevel", zipCompression?.value || "6");
  }
  if (["mp4", "mov", "mkv"].includes(targetFormat)) {
    form.append("videoCodec", videoCodec?.value || "h264");
  }
  if (["mp4", "mov", "mkv", "webm"].includes(targetFormat)) {
    form.append("alphaBackground", alphaBackground?.value || "white");
  }
  if (targetFormat === "pdf" && state.fileInfos.every((info) => info.category === "pdf")) {
    form.append("pdfAction", pdfAction?.value || "");
    if (pdfPassword?.value) form.append("password", pdfPassword.value);
    if (pdfSplitMode?.value) form.append("splitMode", pdfSplitMode.value);
    if (pdfGroupSize?.value) form.append("groupSize", pdfGroupSize.value);
  }

  const response = await fetch("/api/convert", {
    method: "POST",
    body: form
  });
  const result = await parseResponse(response);

  if (!response.ok) {
    throw responseError(result, response.status);
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
  // blanks 语义：空白页在「排除空白页后的上传文件流」中的绝对位置。
  // 前端队列可能含空白页占位，这里按队列顺序把真实文件依次编号，
  // 空白页记录它前面已出现的真实文件个数（即插入到该序号之后）。
  const blankAfter = [];
  let realCount = 0;
  files.forEach((file, index) => {
    if (file?.isBlankPage) {
      blankAfter.push(realCount);
      return;
    }
    form.append("files", file);
    realCount += 1;
  });
  if (state.folderName) form.append("folderName", state.folderName);
  // blanks=0,3 表示：在上传文件流的第 0 个（最前）和第 3 个文件之后插入空白页
  if (blankAfter.length) form.append("blanks", blankAfter.join(","));

  const response = await fetch("/api/convert-images-to-pdf", {
    method: "POST",
    body: form
  });
  const result = await parseResponse(response);

  if (!response.ok) {
    throw responseError(result, response.status);
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
    downloadButton.textContent = `${t("action.save")} ${result.fileName}`;
    downloadButton.hidden = false;
    previewButton.hidden = false;
    batchSaveButton.hidden = true;
    setProgress(100, i18n.language === "en-US" ? "Merge complete" : "合并完成", "success");
    setStatus(i18n.language === "en-US" ? `Images merged into ${result.fileName}.` : `图片已合并为：${result.fileName}。`, "success");
    setMouseState("success");
    setWorkflowStep("save");
  } catch (error) {
    state.batchResults = state.files.map(() => ({
      status: "error",
      detail: error.message || "合并 PDF 失败"
    }));
    renderBatchList();
    setProgress(100, i18n.language === "en-US" ? "Merge failed" : "合并失败", "error");
    setStatus(i18n.language === "en-US" ? `PDF merge failed: ${error.message || "Unknown error"}` : `合并 PDF 失败：${error.message || "未知错误"}`, "error");
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
    throw responseError(result, response.status);
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
    downloadButton.textContent = `${t("action.save")} ${result.fileName}`;
    downloadButton.hidden = false;
    previewButton.hidden = false;
    batchSaveButton.hidden = true;
    setProgress(100, i18n.language === "en-US" ? "Merge complete" : "合并完成", "success");
    setStatus(i18n.language === "en-US" ? `PDF files merged into ${result.fileName}.` : `PDF 已合并为：${result.fileName}。`, "success");
    setMouseState("success");
    setWorkflowStep("save");
  } catch (error) {
    state.batchResults = state.files.map(() => ({
      status: "error",
      detail: error.message || "合并 PDF 失败"
    }));
    renderBatchList();
    setProgress(100, i18n.language === "en-US" ? "Merge failed" : "合并失败", "error");
    setStatus(i18n.language === "en-US" ? `PDF merge failed: ${error.message || "Unknown error"}` : `合并 PDF 失败：${error.message || "未知错误"}`, "error");
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
  setMouseState(mouseStateForConversion(targetFormat));
  setProgress(0, i18n.language === "en-US" ? "Preparing conversion" : "准备转换");
  setWorkflowStep("convert");
  setStatus(i18n.language === "en-US"
    ? (state.files.length === 1 ? "Converting. PDF, Office/WPS, or video files may take longer..." : `Converting ${state.files.length} files...`)
    : (state.files.length === 1 ? "正在转换，请稍等。PDF、Office/WPS 或视频文件可能需要更久..." : `正在批量转换 ${state.files.length} 个文件，请稍等...`));

  if (isMergedImagePdfConversion(targetFormat)) {
    await convertMergedImagesToPdf();
    return;
  }

  if (isMergedPdfConversion(targetFormat)) {
    await convertMergedPdfs();
    return;
  }

  if (isSplitPdfConversion(targetFormat)) {
    setStatus(i18n.language === "en-US" ? "Splitting the PDF into individual pages..." : "正在把 PDF 拆分为单页文件...");
  }

  let successCount = 0;
  let failCount = 0;
  // 单文件长任务（视频/PDF/Office 转码）无实时进度，用不确定滑动动画代替死板的 0%
  const useIndeterminate = state.files.length === 1 && isLongTaskTarget(targetFormat);

  for (let index = 0; index < state.files.length; index += 1) {
    const file = state.files[index];
    setBatchResult(index, { status: "converting", detail: i18n.language === "en-US" ? `Converting to ${targetFormat.toUpperCase()}` : `正在转换为 ${targetFormat.toUpperCase()}` });
    if (useIndeterminate) {
      setIndeterminateProgress(longTaskProgressLabel(targetFormat));
    } else {
      setProgress((index / state.files.length) * 100, i18n.language === "en-US" ? `Converting ${index + 1}/${state.files.length}` : `正在转换 ${index + 1}/${state.files.length}`);
    }

    try {
      const result = await convertOneFile(file, targetFormat);
      successCount += 1;
      let detail = result.fileName;
      if (targetFormat === "zip" && result.compressionRatio != null) {
        detail += `（${formatSize(result.originalBytes || 0)} → ${formatSize(result.compressedBytes || 0)}，压缩 ${result.compressionRatio}%）`;
      }
      const warnings = localizedWarnings(result);
      if (warnings.length) detail += ` — ${warnings.join("；")}`;
      setBatchResult(index, { status: "success", detail, result });
    } catch (error) {
      failCount += 1;
      rendererLog("warn", `转换失败: "${file.name || "未知文件"}" -> ${targetFormat}: ${error.message || error}`);
      setBatchResult(index, { status: "error", detail: error.message || (i18n.language === "en-US" ? "Unknown error" : "未知错误") });
      maybeShowQqTutorial(error);
    }
  }

  const completed = successCount + failCount;
  const type = failCount ? (successCount ? "" : "error") : "success";
  setProgress(100, i18n.language === "en-US"
    ? (failCount ? `Completed ${completed}/${state.files.length}; ${failCount} failed` : "Conversion complete")
    : (failCount ? `完成 ${completed}/${state.files.length}，失败 ${failCount} 个` : "转换完成"), type);

  state.batchResults = [...state.batchResults];
  const successful = state.batchResults.filter((item) => item.status === "success" && item.result);
  state.converted = successful.length === 1 ? successful[0].result : null;

  if (successful.length === 1) {
    downloadButton.href = successful[0].result.downloadUrl;
    downloadButton.download = successful[0].result.fileName;
    downloadButton.textContent = `${t("action.save")} ${successful[0].result.fileName}`;
    downloadButton.hidden = false;
    previewButton.hidden = false;
  }

  batchSaveButton.hidden = successful.length < 2;
  setMouseState(failCount ? "error" : "success");
  if (successful.length) {
    setWorkflowStep("save");
  }
  setStatus(i18n.language === "en-US"
    ? (failCount ? `Batch complete: ${successCount} succeeded, ${failCount} failed. Details appear beside each file. ${t("feedback.hint")}` : `Batch complete: ${successCount} succeeded.`)
    : (failCount ? `批量转换完成：成功 ${successCount} 个，失败 ${failCount} 个。失败原因已显示在对应文件旁边。${t("feedback.hint")}` : `批量转换完成：成功 ${successCount} 个。`),
  failCount ? (successCount ? "" : "error") : "success");

  state.isConverting = false;
  convertButton.disabled = !state.files.length;
  targetSelect.disabled = !state.files.length;
}

async function saveResult(result) {
  if (!result) return;

  if (window.flyingMouseFormat?.saveConvertedFile) {
    setStatus(i18n.language === "en-US" ? `Choose where to save ${result.fileName}...` : `请选择 ${result.fileName} 的保存位置...`);
    const saved = await window.flyingMouseFormat.saveConvertedFile({
      downloadUrl: result.downloadUrl,
      fileName: result.fileName,
      assets: Array.isArray(result.assets) ? result.assets : undefined
    });
    if (saved?.canceled) {
      setStatus(i18n.language === "en-US" ? `Converted: ${result.fileName}. Not saved yet.` : `转换完成：${result.fileName}。尚未保存。`, "success");
      return;
    }
    setStatus(i18n.language === "en-US" ? `Saved to: ${saved.filePath}` : `已保存到：${saved.filePath}`, "success");
    return;
  }

  const link = document.createElement("a");
  link.href = result.downloadUrl;
  link.download = result.fileName;
  link.click();
}

function previewFallback(result, message) {
  const wrapper = document.createElement("div");
  wrapper.className = "preview-fallback";
  wrapper.append(
    createTextElement("p", "preview-fallback-name", result.fileName),
    createTextElement("p", "", message),
    createTextElement("p", "preview-fallback-meta", `${result.mimeType || "application/octet-stream"} · ${formatSize(result.previewSize || 0)}`)
  );
  previewContent.replaceChildren(wrapper);
}

async function renderPreview(result) {
  previewTitle.textContent = result.fileName || t("preview.title");
  previewMeta.textContent = `${result.mimeType || "application/octet-stream"} · ${formatSize(result.previewSize || 0)}`;
  previewContent.replaceChildren(createTextElement("p", "preview-loading", t("preview.loading")));
  const previewKind = result.previewKind;
  if (!result.previewUrl || previewKind === "unsupported") {
    previewFallback(result, t("preview.unsupported"));
    return;
  }
  if (previewKind === "image") {
    const image = document.createElement("img");
    image.className = "preview-image";
    image.alt = result.fileName;
    image.src = result.previewUrl;
    previewContent.replaceChildren(image);
    return;
  }
  if (previewKind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.title = result.fileName;
    frame.src = result.previewUrl;
    previewContent.replaceChildren(frame);
    return;
  }
  if (previewKind === "audio" || previewKind === "video") {
    const media = document.createElement(previewKind);
    media.className = `preview-${previewKind}`;
    media.controls = true;
    media.preload = "metadata";
    media.src = result.previewUrl;
    previewContent.replaceChildren(media);
    return;
  }
  if (previewKind === "text") {
    if ((result.previewSize || 0) > 2 * 1024 * 1024) {
      previewFallback(result, t("preview.tooLarge"));
      return;
    }
    const response = await fetch(result.previewUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pre = document.createElement("pre");
    pre.className = "preview-text";
    pre.textContent = await response.text();
    previewContent.replaceChildren(pre);
    return;
  }
  previewFallback(result, t("preview.unsupported"));
}

async function openPreview(result, opener) {
  if (!result) return;
  state.previewResult = result;
  state.previewOpener = opener || document.activeElement;
  previewDrawer.hidden = false;
  previewBackdrop.hidden = false;
  document.body.classList.add("preview-open");
  previewClose.focus();
  try {
    await renderPreview(result);
  } catch (error) {
    previewFallback(result, t("preview.failed", { message: error.message || "unknown" }));
  }
}

function closePreview() {
  if (!previewDrawer || previewDrawer.hidden) return;
  previewDrawer.hidden = true;
  previewBackdrop.hidden = true;
  previewContent.replaceChildren();
  document.body.classList.remove("preview-open");
  const opener = state.previewOpener;
  state.previewResult = null;
  state.previewOpener = null;
  if (opener && document.contains(opener)) opener.focus();
}

async function saveConvertedFile(event) {
  if (!state.converted) return;
  event.preventDefault();

  try {
    await saveResult(state.converted);
  } catch (error) {
    setStatus(i18n.language === "en-US" ? `Save failed: ${error.message || "Unknown error"}` : `保存失败：${error.message || "未知错误"}`, "error");
  }
}

async function saveAllConvertedFiles() {
  const results = state.batchResults
    .filter((item) => item.status === "success" && item.result)
    .map((item) => item.result);
  if (!results.length) return;

  try {
    if (window.flyingMouseFormat?.saveConvertedFiles) {
      setStatus(i18n.language === "en-US" ? `Choose a folder for ${results.length} files...` : `请选择 ${results.length} 个文件的保存文件夹...`);
      const saved = await window.flyingMouseFormat.saveConvertedFiles({ files: results });
      if (saved?.canceled) {
        setStatus(i18n.language === "en-US" ? `${results.length} files converted. Not saved yet.` : `已转换 ${results.length} 个文件，尚未保存。`, "success");
        return;
      }
      const failList = Array.isArray(saved?.failed) ? saved.failed : [];
      if (failList.length) {
        const names = failList.map((f) => f.name).join("、");
        setStatus(i18n.language === "en-US"
          ? `Saved ${saved.savedCount}; ${failList.length} failed (${names}). ${failList[0].reason}`
          : `已保存 ${saved.savedCount} 个，失败 ${failList.length} 个（${names}）。${failList[0].reason}`, "error");
      } else {
        setStatus(i18n.language === "en-US" ? `Saved ${saved.savedCount} files to: ${saved.directory}` : `已保存 ${saved.savedCount} 个文件到：${saved.directory}`, "success");
      }
      return;
    }

    for (const result of results) {
      const link = document.createElement("a");
      link.href = result.downloadUrl;
      link.download = result.fileName;
      link.click();
    }
  } catch (error) {
    setStatus(i18n.language === "en-US" ? `Save all failed: ${error.message || "Unknown error"}` : `保存全部失败：${error.message || "未知错误"}`, "error");
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

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  // 支持拖入文件夹：遍历 items 用 webkitGetAsEntry 递归收集文件，
  // 并把文件夹名记录到 state.folderName（用于图片合并 PDF 命名）。
  const items = [...(event.dataTransfer?.items || [])];
  const entries = items.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
  const hasDirectory = entries.some((entry) => entry?.isDirectory);
  if (hasDirectory) {
    const collected = [];
    let firstDirName = "";
    for (const entry of entries) {
      await collectEntryFiles(entry, collected, (dirName) => { firstDirName = firstDirName || dirName; });
    }
    if (collected.length) {
      state.folderName = firstDirName || "";
      acceptFiles(collected);
      return;
    }
  }
  acceptFiles(event.dataTransfer.files);
});

// 递归收集文件夹/文件条目（webkitGetAsEntry），onDirName 回调首个目录名。
async function collectEntryFiles(entry, collected, onDirName) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve));
    if (file) collected.push(file);
    return;
  }
  if (entry.isDirectory) {
    if (onDirName) onDirName(entry.name);
    const reader = entry.createReader();
    let batch = await new Promise((resolve) => reader.readEntries(resolve));
    // readEntries 可能分批返回，循环读到空
    while (batch && batch.length) {
      for (const child of batch) await collectEntryFiles(child, collected, onDirName);
      batch = await new Promise((resolve) => reader.readEntries(resolve));
    }
  }
}

fileInput.addEventListener("change", () => {
  acceptFiles(fileInput.files);
});

// 选择文件夹：webkitdirectory input 的每个 File 带 webkitRelativePath
// （如 "相册2026/001.jpg"），acceptFiles 用第一个路径段做文件夹名。
chooseFolderButton.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => {
  if (folderInput.files?.length) {
    acceptFiles(folderInput.files);
    folderInput.value = "";
  }
});

batchList.addEventListener("click", async (event) => {
  const moveButton = event.target.closest("[data-move]");
  if (moveButton) {
    moveFileInQueue(Number(moveButton.dataset.move), moveButton.dataset.direction);
    return;
  }
  const blankInsert = event.target.closest("[data-insert-blank]");
  if (blankInsert) {
    insertBlankPage(Number(blankInsert.dataset.insertBlank));
    return;
  }
  const blankRemove = event.target.closest("[data-remove-blank]");
  if (blankRemove) {
    removeBlankPage(Number(blankRemove.dataset.removeBlank));
    return;
  }
  const previewAction = event.target.closest("[data-preview-index]");
  if (previewAction) {
    const result = state.batchResults[Number(previewAction.dataset.previewIndex)]?.result;
    await openPreview(result, previewAction);
    return;
  }
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

// 在队列 index 之后插入一页空白页（仅图片合并 PDF 时可用）
function insertBlankPage(index) {
  if (!canReorderImages()) return;
  const blankPage = { isBlankPage: true, name: "空白页", size: 0 };
  const at = Math.min(index + 1, state.files.length);
  state.files.splice(at, 0, blankPage);
  state.fileInfos.splice(at, 0, { extension: "", category: "image", targets: ["pdf"], experimental: false });
  state.batchResults.splice(at, 0, { status: "pending", detail: "等待转换" });
  renderBatchList();
}

function removeBlankPage(index) {
  if (!canReorderImages()) return;
  if (!state.files[index]?.isBlankPage) return;
  state.files.splice(index, 1);
  state.fileInfos.splice(index, 1);
  state.batchResults.splice(index, 1);
  renderBatchList();
}

clearButton.addEventListener("click", clearFile);
convertButton.addEventListener("click", convertCurrentFiles);
languageSelect.addEventListener("change", async () => {
  i18n.setLanguage(languageSelect.value, { persist: false });
  if (typeof logBridge.updateSettings === "function") {
    state.settings = await logBridge.updateSettings({ language: i18n.language });
  }
  refreshLanguage();
});
targetSelect.addEventListener("change", async () => {
  syncZipCompressionField();
  syncVideoCodecField();
  syncPdfActionFields();
  syncPdfExcelHint();
  renderBatchList();
  const targetBySource = rememberTarget(
    state.settings.targetBySource,
    state.files.map((file) => extensionOf(file.name)),
    targetSelect.value
  );
  if (typeof logBridge.updateSettings === "function") {
    state.settings = await logBridge.updateSettings({ targetBySource });
  } else {
    state.settings.targetBySource = targetBySource;
  }
});
downloadButton.addEventListener("click", saveConvertedFile);
batchSaveButton.addEventListener("click", saveAllConvertedFiles);
if (pdfAction) pdfAction.addEventListener("change", syncPdfActionFields);
if (pdfSplitMode) pdfSplitMode.addEventListener("change", syncPdfActionFields);
previewButton.addEventListener("click", () => openPreview(state.converted, previewButton));
previewClose.addEventListener("click", closePreview);
previewBackdrop.addEventListener("click", closePreview);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !previewDrawer.hidden) closePreview();
});
agentInstallButton.addEventListener("click", async () => {
  if (typeof logBridge.inspectAgentSkillTargets !== "function" || typeof logBridge.installAgentSkill !== "function") return;
  agentInstallButton.disabled = true;
  setStatus(t("agent.checking"));
  try {
    const inspected = await logBridge.inspectAgentSkillTargets();
    if (!inspected?.targets?.length) {
      setStatus(t("agent.none"));
      return;
    }
    const result = await logBridge.installAgentSkill({ targetIds: inspected.targets.map((item) => item.id) });
    if (result?.canceled) {
      setStatus(t("agent.canceled"));
    } else if (result.failed?.length) {
      setStatus(t("agent.partial", {
        count: result.installed.length,
        failed: result.failed.length,
        message: result.failed.map((item) => item.error).join("；")
      }), result.installed.length ? "success" : "error");
    } else {
      setStatus(t("agent.installed", {
        count: result.installed.length,
        paths: result.installed.map((item) => item.path).join("；")
      }), "success");
    }
  } catch (error) {
    setStatus(t("agent.failed", { message: error.message || "unknown" }), "error");
  } finally {
    agentInstallButton.disabled = false;
  }
});
diagnosticsButton.addEventListener("click", async () => {
  if (typeof logBridge.exportDiagnostics !== "function") return;
  diagnosticsButton.disabled = true;
  try {
    const result = await logBridge.exportDiagnostics();
    setStatus(result?.canceled
      ? t("diagnostics.canceled")
      : t("diagnostics.saved", { path: result.filePath }), result?.canceled ? "" : "success");
  } catch (error) {
    setStatus(t("diagnostics.failed", { message: error.message || "unknown" }), "error");
    rendererLog("error", "导出诊断失败", error);
  } finally {
    diagnosticsButton.disabled = false;
  }
});

compressFolderButton.addEventListener("click", async () => {
  if (typeof logBridge.compressFolder !== "function") {
    setStatus(t("compressFolder.failed", { message: "compression is only available in the desktop app" }), "error");
    return;
  }
  compressFolderButton.disabled = true;
  try {
    const result = await logBridge.compressFolder({ compressionLevel: 6 });
    if (result?.canceled) {
      setStatus(t("compressFolder.canceled"));
    } else {
      setStatus(t("compressFolder.saved", { count: result.fileCount, path: result.filePath }), "success");
    }
  } catch (error) {
    setStatus(t("compressFolder.failed", { message: error.message || "unknown" }), "error");
    rendererLog("error", "压缩文件夹失败", error);
  } finally {
    compressFolderButton.disabled = false;
  }
});

async function initializeDurableSettings() {
  const legacy = {
    targetBySource: readPreferences(localStorage),
    language: (() => {
      try { return localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch { return null; }
    })()
  };
  if (typeof logBridge.migrateLegacySettings === "function") {
    state.settings = await logBridge.migrateLegacySettings(legacy);
    try {
      localStorage.removeItem(LEGACY_TARGET_STORAGE_KEY);
      localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    } catch {
      // A blocked origin store must not prevent startup after main settings load.
    }
  } else if (typeof logBridge.getSettings === "function") {
    state.settings = await logBridge.getSettings();
  } else {
    state.settings.targetBySource = legacy.targetBySource;
  }
  i18n.setLanguage(state.settings.language || navigator.language, { persist: false });
}

async function initializeApp() {
  await initializeDurableSettings();
  applyStaticTranslations();
  setMouseState("upload");
  setWorkflowStep("select");
  await fetchCapabilities();
  initializeUpdateWidget();
}

// ---- 版本号与自动更新状态（NSIS 版；开发/商店版静默降级）----
const appVersionEl = document.querySelector("#appVersion");
const updateButton = document.querySelector("#updateButton");
const updateStatusEl = document.querySelector("#updateStatus");

function renderUpdateStatus(status) {
  const kind = status?.status;
  const version = status?.version || "";
  const message = status?.message || "unknown";
  let text = "";
  let tone = "";
  if (kind === "checking") text = t("update.checking");
  else if (kind === "upToDate") { text = t("update.latest"); tone = "ok"; }
  else if (kind === "available") text = t("update.available", { version });
  else if (kind === "downloaded") { text = t("update.downloaded", { version }); tone = "ok"; }
  else if (kind === "error") { text = t("update.error", { message }); tone = "error"; }
  else if (kind === "unavailable") text = t("update.unavailable");

  // 检测到新版本才亮出「检查更新」入口（默认隐藏，不打扰用户）。
  if (kind === "available" || kind === "downloaded") {
    updateButton.hidden = false;
  }

  // 状态文本：有新版本或手动检查中时显示；无更新/出错静默。
  const showStatus = kind === "available" || kind === "downloaded" || kind === "checking";
  if (!text || !showStatus) {
    updateStatusEl.hidden = true;
    return;
  }
  updateStatusEl.textContent = text;
  updateStatusEl.hidden = false;
  updateStatusEl.classList.toggle("update-error", tone === "error");
  updateStatusEl.classList.toggle("update-ok", tone === "ok");
}

function initializeUpdateWidget() {
  if (!window.flyingMouseFormat) {
    updateButton.hidden = true;
    return;
  }
  window.flyingMouseFormat.getAppVersion()
    .then((version) => {
      if (version) appVersionEl.textContent = `v${version}`;
    })
    .catch(() => {});
  window.flyingMouseFormat.onUpdateStatus((status) => renderUpdateStatus(status));
  updateButton.addEventListener("click", async () => {
    updateButton.disabled = true;
    renderUpdateStatus({ status: "checking" });
    try {
      const result = await window.flyingMouseFormat.checkForUpdates();
      renderUpdateStatus(result);
    } catch (error) {
      renderUpdateStatus({ status: "error", message: String(error?.message || "") });
    } finally {
      updateButton.disabled = false;
    }
  });
}

initializeApp().catch((error) => {
  setMouseState("error");
  toolHealth.textContent = t("health.failed");
  setStatus(error.message, "error");
  rendererLog("error", "能力检测失败", error);
});

/* --- QQ 音乐登录教程弹窗 --- */
const qqTutorialModal = document.querySelector("#qqTutorialModal");
const qqTutorialBackdrop = document.querySelector("#qqTutorialBackdrop");
const qqTutorialClose = document.querySelector("#qqTutorialClose");
const qqTutorialGotIt = document.querySelector("#qqTutorialGotIt");

function openQqTutorial() {
  qqTutorialModal.hidden = false;
}

function closeQqTutorial() {
  qqTutorialModal.hidden = true;
}

qqTutorialClose.addEventListener("click", closeQqTutorial);
qqTutorialGotIt.addEventListener("click", closeQqTutorial);
qqTutorialBackdrop.addEventListener("click", closeQqTutorial);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !qqTutorialModal.hidden) closeQqTutorial();
});

// 图解缺失时隐藏破图占位，只保留文字步骤（图片在弹窗打开前就 404 时触发）。
qqTutorialModal.querySelectorAll(".step-figure img").forEach((img) => {
  img.addEventListener("error", () => {
    img.hidden = true;
  });
});

// musicex 解密需要 QQ 音乐登录凭据：失败时自动弹出教程。
const QQ_COOKIE_ERROR_CODES = new Set(["MFLAC_EKEY_REQUIRED", "MFLAC_EKEY_NETWORK"]);

function maybeShowQqTutorial(error) {
  if (error && QQ_COOKIE_ERROR_CODES.has(String(error.errorCode || ""))) {
    openQqTutorial();
    return true;
  }
  return false;
}

// 复制 cookie 模板到剪贴板（供用户粘贴到桌面 QQ音乐_登录cookie.txt）
const qqCookieTemplate = document.querySelector("#qqCookieTemplate");
const qqCookieTemplateCopy = document.querySelector("#qqCookieTemplateCopy");

async function copyQqCookieTemplate() {
  const templateText = qqCookieTemplate.textContent;
  try {
    await navigator.clipboard.writeText(templateText);
    setStatus(t("tutorial.copied"), "success");
  } catch {
    // clipboard API 不可用时选中模板文本，提示用户手动 Ctrl+C
    const range = document.createRange();
    range.selectNodeContents(qqCookieTemplate);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    setStatus(i18n.language === "en-US"
      ? "Template selected. Press Ctrl+C to copy it, then paste into Notepad."
      : "模板已选中，请按 Ctrl+C 复制，再到记事本粘贴。", "success");
  }
}

qqCookieTemplateCopy.addEventListener("click", copyQqCookieTemplate);
const sponsorToggle = document.querySelector("#sponsorToggle");
const sponsorPanel = document.querySelector("#sponsorPanel");
const sponsorClose = document.querySelector("#sponsorClose");
const sponsorWidget = document.querySelector("#sponsorWidget");

function setSponsorOpen(open) {
  sponsorPanel.hidden = !open;
  sponsorToggle.setAttribute("aria-expanded", String(open));
}

if (sponsorToggle && sponsorPanel && sponsorClose && sponsorWidget) {
  sponsorToggle.addEventListener("click", () => setSponsorOpen(sponsorPanel.hidden));
  sponsorClose.addEventListener("click", () => setSponsorOpen(false));
  document.addEventListener("click", (event) => {
    if (!sponsorPanel.hidden && !sponsorWidget.contains(event.target)) setSponsorOpen(false);
  });
}
