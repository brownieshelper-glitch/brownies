// Writes the coin logo as SVG files for the site (mark and favicon) from the one drawing in web/mascot.js.
// Run from agent-company/brand:  node make-assets.mjs
// The PNG files (logo-512, logo-1024, og, banner) are screenshots of logo.html, og.html and banner.html.
import fs from "node:fs";
await import("../web/mascot.js");
const svg = globalThis.Mascot.coin({ shape: "round" });
fs.writeFileSync("../web/assets/mark.svg", svg + "\n");
fs.writeFileSync("../web/assets/favicon.svg", svg + "\n");
console.log("mark.svg and favicon.svg written, " + svg.length + " bytes each");
