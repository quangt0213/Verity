// Apply the saved theme before React mounts to avoid a light/dark flash.
// Mirrors ThemeProvider: an explicit "light"/"dark" choice wins, otherwise the OS preference
// (inside Maypop, ThemeProvider switches "system" to the host theme once the SDK connects).
(function () {
  var theme = "light";
  try {
    var saved = JSON.parse(localStorage.getItem("verity.theme") || "null");
    if (saved === "light" || saved === "dark") theme = saved;
    else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  } catch {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
})();
