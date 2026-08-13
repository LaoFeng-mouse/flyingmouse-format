// 极早执行：在 CSS 应用前根据已保存偏好或系统设置确定主题，避免浅色闪烁。
// 单独成文件以满足项目 CSP（script-src 'self' 不允许内联脚本）。
(function () {
  try {
    var saved = localStorage.getItem("flyingmouse.theme.v1");
    var theme;
    if (saved === "dark" || saved === "light") {
      theme = saved;
    } else {
      var prefersDark =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      theme = prefersDark ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
