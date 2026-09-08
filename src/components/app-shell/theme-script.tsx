import { THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * Runs before first paint, so nobody sees the wrong theme flash and change.
 * Kept out of theme-toggle.tsx so the root layout can render it without
 * pulling a client component into every page.
 *
 * Deliberately a string of plain JavaScript rather than a module: it has to
 * execute synchronously in the document head, before React exists. It mirrors
 * `themeAttribute` in @/lib/theme, which is where the rule is stated and
 * tested — keep the two in step.
 */
export function ThemeScript() {
  const script =
    "(function(){var d=document.documentElement;try{" +
    `var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
    // "system" is the one value that means "take the attribute off and let
    // prefers-color-scheme answer". Everything else, including nothing at all,
    // is light unless dark was explicitly chosen.
    "if(t==='system'){d.removeAttribute('data-theme');}" +
    "else{d.setAttribute('data-theme',t==='dark'?'dark':'light');}" +
    "}catch(e){d.setAttribute('data-theme','light');}})();";

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
