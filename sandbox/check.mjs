// Four jobs through the live sandbox, from the helpers' droplet (the only machine the sandbox port answers):
// a sum that also prints the kernel the box sees (4.19.0-gvisor = the second kernel is on), a network attempt
// that must fail, a loop that must be killed on time, an npm install with network followed by a run without.
// On the droplet: cd /srv/brownies/helpers && set -a && . /etc/brownies/helpers.env && set +a && node /srv/brownies/sandbox-check.mjs
// (sandbox/deploy.sh test copies this file there and runs it.)
import { Sandbox } from "/srv/brownies/helpers/lib/sandbox.mjs";
import { gzipSync } from "node:zlib";

const sb = new Sandbox({ url: process.env.SANDBOX_URL, token: process.env.SANDBOX_TOKEN });
/// A one-file gzip tarball, by hand: the ustar header, the body padded to 512, two empty blocks.
const tarOf = (name, content) => {
  const h = Buffer.alloc(512); h.write(name, 0); h.write("0000644", 100); h.write("0000000", 108); h.write("0000000", 116); h.write(content.length.toString(8).padStart(11, "0"), 124); h.write("00000000000", 136); h.write("        ", 148); h.write("0", 156);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const body = Buffer.concat([Buffer.from(content), Buffer.alloc(512 - (content.length % 512 || 512))]);
  return gzipSync(Buffer.concat([h, body, Buffer.alloc(1024)]));
};
const show = (label, r) => console.log(label, JSON.stringify({ exit: r.exit, timedOut: r.timedOut, s: r.seconds, out: r.stdout.trim().slice(0, 160), err: r.stderr.trim().slice(0, 120) }));
console.log("health:", JSON.stringify(await sb.health()));
const t = tarOf("sum.js", "console.log('sum', 2 + 2, 'kernel', require('os').release());\n");
show("1 sum + kernel:", await sb.run({ tar: t, command: "node sum.js", timeoutSeconds: 60 }));
show("2 network from the box (must be blocked):", await sb.run({ tar: t, command: "node -e \"fetch('https://example.com').then(()=>console.log('REACHED')).catch(e=>console.log('blocked:', e.cause?.code || e.message))\"", timeoutSeconds: 60 }));
show("3 a loop killed at 10 s:", await sb.run({ tar: t, command: "node -e 'for(;;){}'", timeoutSeconds: 10 }));
const p = tarOf("package.json", JSON.stringify({ name: "t", dependencies: { "is-odd": "3.0.1" } }) + "\n");
show("4 npm install with network, then the run without:", await sb.run({ tar: p, install: "npm install --ignore-scripts --no-audit --no-fund", command: "node -e \"console.log('dep', require('is-odd')(3))\"", timeoutSeconds: 60, installTimeoutSeconds: 180 }));
