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

/// Critic's latest feedback for a brownie (and for everyone), as text for its prompt, or "" when there is none.
export function latestCriticText(store, helper, max = 700) {
  const raw = store.getMeta("critic:latest");
  if (!raw) return "";
  let c; try { c = JSON.parse(raw); } catch { return ""; }
  const items = (c.items || []).filter((i) => i.helper === helper || i.helper === "team").map((i) => `- ${i.fix}`);
  return items.length ? `${c.date}: ${items.join("\n").slice(0, max)}` : "";
}

/// Nib's latest note, as text for a prompt, or "" when there is none yet.
export function latestNoteText(store, max = 2500) {
  const n = store.latestNote;
  if (!n) return "";
  return `${n.date}: ${String(n.text).slice(0, max)}`;
}
