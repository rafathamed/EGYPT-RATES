import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const assetsDir = process.argv[2] ?? "release-assets";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;
const repository = process.env.GITHUB_REPOSITORY ?? "rafathamed/EGYPT-RATES";
const tag = `v${version}`;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

const files = await walk(assetsDir);
const nsis = files.find((file) => file.toLowerCase().includes("/nsis/") && file.toLowerCase().endsWith(".exe"));
const msi = files.find((file) => file.toLowerCase().includes("/msi/") && file.toLowerCase().endsWith(".msi"));
if (!nsis || !msi) {
  throw new Error("Expected both Windows NSIS (.exe) and MSI installers in the downloaded build artifact.");
}

async function platformEntry(installerPath) {
  const signaturePath = `${installerPath}.sig`;
  const signature = (await readFile(signaturePath, "utf8")).trim();
  if (!signature) throw new Error(`Missing updater signature: ${signaturePath}`);
  const assetName = basename(installerPath);
  return {
    signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(assetName)}`
  };
}

const manifest = {
  version,
  notes: "تحديث EGYPT RATES. نزّل التحديث وثبّته مباشرة من داخل التطبيق.",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64-nsis": await platformEntry(nsis),
    "windows-x86_64-msi": await platformEntry(msi)
  }
};

const output = join(assetsDir, "latest.json");
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Generated signed updater manifest for EGYPT RATES ${version}: ${output}`);
