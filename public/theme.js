// Resolve the cached/system theme before the first stylesheet is painted.
(function () {
  const key = "flyingmouse.theme.v1";
  const valid = (value) => ["system", "light", "dark"].includes(value);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  let changedByUser = false;
  try {
    const cached = localStorage.getItem(key);
    if (valid(cached)) preference = cached;
  } catch { /* A blocked browser store must not prevent theme changes. */ }

  function render() {
    const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    const select = document.querySelector("#themeSelect");
    if (select) select.value = preference;
  }

  function cache() {
    try { localStorage.setItem(key, preference); } catch { /* Main settings remain authoritative. */ }
  }

  window.FlyingMouseTheme = {
    get preference() { return preference; },
    select(value) {
      preference = valid(value) ? value : "system";
      changedByUser = true;
      render();
      cache();
      return preference;
    },
    restore(value) {
      // A late startup IPC response must not undo a selection already made.
      if (!changedByUser && valid(value)) {
        preference = value;
        cache();
      }
      render();
    }
  };
  media.addEventListener("change", () => {
    if (preference === "system") render();
  });
  document.addEventListener("DOMContentLoaded", render, { once: true });
  render();
})();
