// The facts file (helpers/facts.md) is the only source of claims for Fudge and Crumb, next to Nib's latest note.
import { readFileSync, existsSync } from "node:fs";

export const HELPERS = ["fudge", "crumb", "nib", "chip"];
export const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/// The facts as one string, cut to a size a prompt can carry.
export function loadFacts(file = new URL("../facts.md", import.meta.url), max = 7000) {
  const p = file instanceof URL ? file : String(file);
  if (!existsSync(p)) return "";
  const t = readFileSync(p, "utf8").replace(/\r/g, "");
  return t.length > max ? t.slice(0, max) : t;
}

/// Nib's latest note, as text for a prompt, or "" when there is none yet.
export function latestNoteText(store, max = 2500) {
  const n = store.latestNote;
  if (!n) return "";
  return `${n.date}: ${String(n.text).slice(0, max)}`;
}
