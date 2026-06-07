// Generates the raster favicons from ui/public/favicon.svg (the WorkcellMark).
// Run:  node scripts/generate-favicon.mjs
// sharp is a @workcell/server dependency, resolved via createRequire below so
// this script works regardless of cwd / pnpm package context.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "server", "package.json"));
const sharp = require("sharp");

const pub = join(root, "ui", "public");
const svg = await readFile(join(pub, "favicon.svg"));

// Rasterize the SVG natively at each target size (density = size*3 since the
// viewBox is 24 units => 24*density/72 px) so every size stays crisp.
const png = (size) =>
  sharp(svg, { density: Math.max(72, size * 3) })
    .resize(size, size, { fit: "contain" })
    .png()
    .toBuffer();

// Standalone PNG variants referenced by index.html / the web manifest.
await writeFile(join(pub, "favicon-16x16.png"), await png(16));
await writeFile(join(pub, "favicon-32x32.png"), await png(32));
await writeFile(join(pub, "apple-touch-icon.png"), await png(180));
// PWA manifest icons (site.webmanifest).
await writeFile(join(pub, "android-chrome-192x192.png"), await png(192));
await writeFile(join(pub, "android-chrome-512x512.png"), await png(512));

// favicon.ico — a PNG-encoded ICO container (16/32/48), supported by all modern
// browsers and Windows. Build the ICO header + directory + PNG blobs by hand so
// no extra .ico dependency is needed.
const icoSizes = [16, 32, 48];
const icoPngs = await Promise.all(icoSizes.map(png));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(icoPngs.length, 4); // image count
const dir = Buffer.alloc(16 * icoPngs.length);
let offset = 6 + 16 * icoPngs.length;
icoPngs.forEach((buf, i) => {
  const size = icoSizes[i];
  const e = 16 * i;
  dir.writeUInt8(size >= 256 ? 0 : size, e + 0); // width (0 means 256)
  dir.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
  dir.writeUInt8(0, e + 2); // color palette
  dir.writeUInt8(0, e + 3); // reserved
  dir.writeUInt16LE(1, e + 4); // color planes
  dir.writeUInt16LE(32, e + 6); // bits per pixel
  dir.writeUInt32LE(buf.length, e + 8); // image byte size
  dir.writeUInt32LE(offset, e + 12); // offset from file start
  offset += buf.length;
});
await writeFile(join(pub, "favicon.ico"), Buffer.concat([header, dir, ...icoPngs]));

console.log(
  "Generated favicons in ui/public: favicon.ico (16/32/48), favicon-16x16.png, " +
    "favicon-32x32.png, apple-touch-icon.png, android-chrome-192x192.png, android-chrome-512x512.png",
);
