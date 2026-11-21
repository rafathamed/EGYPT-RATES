import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The uploaded ICO is the authoritative brand asset. Never regenerate it from
// a legacy SVG: copy the exact multi-size file into Tauri and the UI assets.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sourcePath = resolve(root, "Asset 3.ico");
const tauriIconDir = resolve(root, "src-tauri/icons");
const publicDir = resolve(root, "public");
const source = await readFile(sourcePath);

if (source.length < 22) {
  throw new Error("Asset 3.ico is missing or too small to be a valid ICO file.");
}
if (source.readUInt16LE(0) !== 0 || source.readUInt16LE(2) !== 1) {
  throw new Error("Asset 3.ico has an invalid ICO header.");
}
const imageCount = source.readUInt16LE(4);
const directoryEnd = 6 + imageCount * 16;
if (imageCount < 1 || directoryEnd > source.length) {
  throw new Error("Asset 3.ico contains an invalid image directory.");
}

const dimensions = [];
for (let index = 0; index < imageCount; index += 1) {
  const entry = 6 + index * 16;
  const width = source[entry] || 256;
  const height = source[entry + 1] || 256;
  const bytes = source.readUInt32LE(entry + 8);
  const offset = source.readUInt32LE(entry + 12);
  if (bytes <= 0 || offset < directoryEnd || offset + bytes > source.length) {
    throw new Error(`Asset 3.ico has an invalid image frame at index ${index}.`);
  }
  dimensions.push(`${width}x${height}`);
}

await mkdir(tauriIconDir, { recursive: true });
await mkdir(publicDir, { recursive: true });
await writeFile(resolve(tauriIconDir, "icon.ico"), source);
await writeFile(resolve(publicDir, "app-mark.ico"), source);

console.log(`Installed the uploaded EGYPT RATES icon: ${imageCount} frames (${dimensions.join(", ")}).`);
