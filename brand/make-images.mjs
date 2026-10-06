// Renders the Brownies picture pack into a folder, with headless Edge.
//   node make-images.mjs [outputFolder]      default: the Desktop folder "brownies images"
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const out = resolve(process.argv[2] || "C:/Users/andrea/OneDrive/Desktop/brownies images");
mkdirSync(out, { recursive: true });
const page = (p) => pathToFileURL(resolve(here, p.split("?")[0])).href + (p.includes("?") ? "?" + p.split("?")[1] : "");

// name, window size, page, transparent background
const jobs = [
  ["profile picture square 1024.png", "1024,1024", "pfp.html?shape=square", true],
  ["profile picture round 1024.png", "1024,1024", "pfp.html?shape=round", true],
  ["profile picture square 400.png", "400,400", "pfp.html?shape=square", true],
  ["banner X 1500x500 light.png", "1500,500", "banner.html", false],
  ["banner X 1500x500 dark.png", "1500,500", "banner-dark.html", false],
  ["share image 1200x630.png", "1200,630", "og.html", false],
  ["wordmark on light 1600x600.png", "1600,600", "wordmark.html?theme=bone&mark=1", false],
  ["wordmark on dark 1600x600.png", "1600,600", "wordmark.html?theme=ink&mark=1", false],
  ["wordmark transparent 1600x600.png", "1600,600", "wordmark.html?theme=none", true],
  ["the team 1600x1340.png", "1600,1340", "team.html", false],
  ["fudge transparent 1200.png", "1200,1200", "helper.html?id=fudge", true],
  ["crumb transparent 1200.png", "1200,1200", "helper.html?id=crumb", true],
  ["nib transparent 1200.png", "1200,1200", "helper.html?id=nib", true],
  ["chip transparent 1200.png", "1200,1200", "helper.html?id=chip", true],
];
for (const [name, size, p, transparent] of jobs) {
  const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=" + size, "--virtual-time-budget=6000", "--screenshot=" + resolve(out, name), page(p)];
  if (transparent) args.splice(3, 0, "--default-background-color=00000000");
  const r = spawnSync(EDGE, args, { stdio: "ignore", timeout: 90_000 });
  console.log((r.status === 0 ? "ok   " : "?    ") + name);
}
console.log("folder: " + out);
