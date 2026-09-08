"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import {
  isTheme,
  THEME_STORAGE_KEY,
  themeAttribute,
  type Theme,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const attribute = themeAttribute(theme);

  if (attribute === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", attribute);
}

export function ThemeToggle() {
  // Light unless this browser has been told otherwise, matching the script in
  // the document head so the first paint and the first render agree.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (isTheme(stored)) {
        setTheme(stored);
        applyTheme(stored);
      }
    } catch {
      // Private mode or blocked storage: the default stands, and the choice
      // simply will not persist.
    }
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Preference simply will not persist; the page still renders correctly.
    }
  }

  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: "light", icon: Sun, label: "Light" },
    { value: "system", icon: Monitor, label: "System" },
    { value: "dark", icon: Moon, label: "Dark" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className={cn(
            "flex h-6.5 w-7 items-center justify-center rounded-md transition-colors",
            theme === value
              ? "bg-surface text-ink shadow-xs"
              : "text-ink-subtle hover:text-ink",
          )}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      ))}
    </div>
  );
}
