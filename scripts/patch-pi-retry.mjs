import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retryFiles = [
  path.join(projectRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
  path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
];

const marker = "pi-web transient gateway compatibility";
const anchor = '    "524",\n';
const addition = [
  `    // ${marker}: some OpenAI-compatible gateways use these`,
  "    // responses for temporary upstream routing failures.",
  '    "403 status code \\\\(no body\\\\)",',
  '    "upstream.?access.?forbidden",',
].join("\n") + "\n";

let patched = 0;
let present = 0;

for (const retryFile of retryFiles) {
  try {
    await access(retryFile);
  } catch {
    continue;
  }

  const source = await readFile(retryFile, "utf8");
  if (source.includes(marker)) {
    present += 1;
    continue;
  }
  if (!source.includes(anchor)) {
    throw new Error(`Could not find retry pattern anchor in ${retryFile}`);
  }

  await writeFile(retryFile, source.replace(anchor, anchor + addition), "utf8");
  patched += 1;
}

if (patched + present === 0) {
  throw new Error("Could not find an installed @earendil-works/pi-ai retry classifier");
}

console.log(`[pi-web] transient gateway retry patch: ${patched} updated, ${present} already present`);
