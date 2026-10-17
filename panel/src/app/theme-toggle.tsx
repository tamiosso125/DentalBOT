"use client";

import { useEffect, useState } from "react";

type Theme = "auto" | "light" | "dark";
const KEY = "dentalbot-theme";
const LABELS: Record<Theme, string> = {
  auto: "Tema: automático",
  light: "Tema: claro",
  dark: "Tema: escuro",
};
const NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };

function apply(theme: Theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("auto");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {
      // storage blocked: stay on automatic
    }
  }, []);
  const change = () => {
    const next = NEXT[theme];
    setTheme(next);
    apply(next);
    try {
      if (next === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // storage blocked: the choice lasts until the page reloads
    }
  };
  return (
    <button type="button" className="secondary theme-toggle" onClick={change}>
      {LABELS[theme]}
    </button>
  );
}
