// Loaded in <head> so the saved theme applies before first paint. With no
// data-theme attribute the CSS follows the system setting.
(() => {
  const NEXT = { system: "light", light: "dark", dark: "system" };
  const ICONS = { system: "brightness_auto", light: "light_mode", dark: "dark_mode" };
  let theme = "system";
  try { if (localStorage.getItem("hb.theme") in NEXT) theme = localStorage.getItem("hb.theme"); } catch {}

  const apply = () => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
    const btn = document.getElementById("themeBtn");
    if (!btn) return;
    btn.firstElementChild.textContent = ICONS[theme];
    btn.title = btn.ariaLabel = `Theme: ${theme}`;
  };
  apply();
  addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("themeBtn").onclick = () => {
      theme = NEXT[theme];
      try { localStorage.setItem("hb.theme", theme); } catch {}
      apply();
      // Mermaid reads the colors once, at load.
      if (document.querySelector(".mermaid")) location.reload();
    };
  });
})();
