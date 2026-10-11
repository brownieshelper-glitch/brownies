// Programmable's CLI fsyncs the directory after every atomic write (io.mjs syncDirectory). Windows refuses fsync on a
// directory handle (EPERM), so the CLI dies on this machine. This preload keeps the CLI's files byte-identical and only
// makes a DIRECTORY sync a no-op on Windows; a file sync still runs and still fails loudly if it must.
//
//   node --import ./win-fsync-shim.mjs <cli>/bin/programmable-launch.mjs ...   (pack.mjs does this)
import fs from "node:fs";

if (process.platform === "win32") {
  const probe = await fs.promises.open(process.execPath, "r");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const original = proto.sync;
  proto.sync = async function patchedSync() {
    try {
      return await original.call(this);
    } catch (e) {
      if (e && e.code === "EPERM" && (await this.stat()).isDirectory()) return undefined;
      throw e;
    }
  };
}
