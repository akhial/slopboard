// Light or dark. By default the page follows the system setting; the masthead toggle can pin
// either one, and the choice is remembered per browser. The colours themselves live in
// styles.css (light-dark() pairs); this only sets which scheme the page uses.

import { useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const STORE_KEY = "slopboard.theme.v1";
const ORDER: readonly ThemeChoice[] = ["system", "light", "dark"];

function stored(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return ORDER.find((t) => t === raw) ?? "system";
  } catch {
    return "system";
  }
}

/** Writes the choice onto <html>, where the stylesheet picks it up. */
export function applyTheme(choice: ThemeChoice = stored()): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function useTheme(): [ThemeChoice, () => void] {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  const next = () => {
    const after = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? "system";
    setChoice(after);
    applyTheme(after);
    try {
      if (after === "system") localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, after);
    } catch {
      // Private mode: the choice holds for this page view.
    }
  };
  return [choice, next];
}

