import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const svgPath = resolve(root, "src-tauri/icons/icon.svg");
const outputDir = resolve(root, "src-tauri/icons");
const svg = await readFile(svgPath);

await mkdir(outputDir, { recursive: true });

const sizes = [16, 24, 32, 40, 48, 64, 128, 256];
const frames = [];
for (const size of sizes) {
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false }
  });
  frames.push({ size, bytes: renderer.render().asPng() });
}

const iconHeader = Buffer.alloc(6);
iconHeader.writeUInt16LE(0, 0);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(frames.length, 4);

const entries = [];
let offset = 6 + frames.length * 16;
for (const frame of frames) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(frame.size === 256 ? 0 : frame.size, 0);
  entry.writeUInt8(frame.size === 256 ? 0 : frame.size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(frame.bytes.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += frame.bytes.length;
}
const ico = Buffer.concat([iconHeader, ...entries, ...frames.map(frame => frame.bytes)]);
await writeFile(resolve(outputDir, "icon.ico"), ico);

const full = new Resvg(svg, {
  fitTo: { mode: "width", value: 1024 },
  font: { loadSystemFonts: false }
}).render().asPng();
await writeFile(resolve(outputDir, "icon.png"), full);
console.log("Generated Windows icon (16–256px) and 1024px PNG.");
