#!/usr/bin/env node
// Turbopack loads server externals through `.next/node_modules/<name>-<hash>`,
// which `next build` creates as links to the project's `node_modules/<name>`.
// Copying a build follows those links on Windows (robocopy, ZIP), leaving a
// second copy of each package. Pi Web then runs an SDK that is not the one it
// resolves, and MCP turns itself off. This replaces each hashed entry with a
// tiny package that re-exports the real one, so the copy is portable and every
// import lands in `app/node_modules`.
//
// Usage: node scripts/link-next-externals.mjs <appDir> [<buildExternalsDir>]
// The second argument lists the hashed names when the copy skipped the links
// (robocopy /XJD); it defaults to <appDir>/.next/node_modules.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const appDir = resolve(process.argv[2] ?? process.cwd());
const externalsDir = join(appDir, ".next", "node_modules");
const serverDir = join(appDir, ".next", "server");
const listingDir = resolve(process.argv[3] ?? externalsDir);
const HASHED = /^(.+)-([0-9a-f]{16})$/;
const MARKER = "pi-web-external-stub";

function hashedEntries() {
  if (!existsSync(listingDir)) return [];
  const entries = [];
  for (const name of readdirSync(listingDir)) {
    if (name.startsWith("@")) {
      for (const inner of readdirSync(join(listingDir, name))) {
        const match = HASHED.exec(inner);
        if (match) entries.push({ id: `${name}/${inner}`, real: `${name}/${match[1]}` });
      }
    } else {
      const match = HASHED.exec(name);
      if (match) entries.push({ id: name, real: match[1] });
    }
  }
  return entries;
}

function* serverFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* serverFiles(path);
    else if (entry.name.endsWith(".js")) yield path;
  }
}

function usedSubpaths(entries) {
  const used = new Map(entries.map((entry) => [entry.id, new Set()]));
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`"(${entries.map((entry) => escape(entry.id)).join("|")})(/[^"]+)?"`, "g");
  for (const file of serverFiles(serverDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) used.get(match[1]).add(match[2] ? `.${match[2]}` : ".");
  }
  for (const set of used.values()) set.add(".");
  return used;
}

function removeEntry(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  // A link or junction: remove only the link, never the package it points to.
  if (stat.isSymbolicLink()) { unlinkSync(path); return; }
  try { unlinkSync(path); } catch { rmSync(path, { recursive: true, force: true }); }
}

const entries = hashedEntries();
if (entries.length === 0) {
  console.log("[pi-web] no hashed Next.js externals to link");
  process.exit(0);
}
const subpaths = usedSubpaths(entries);
for (const { id, real } of entries) {
  const realManifest = join(appDir, "node_modules", real, "package.json");
  if (!existsSync(realManifest)) throw new Error(`${real} is not installed in ${appDir}\\node_modules`);
  const isModule = JSON.parse(readFileSync(realManifest, "utf8")).type === "module";
  const dir = join(externalsDir, id);
  removeEntry(dir);
  mkdirSync(dir, { recursive: true });
  const exportsMap = {};
  for (const subpath of [...subpaths.get(id)].sort()) {
    const specifier = subpath === "." ? real : `${real}/${subpath.slice(2)}`;
    const file = `./${subpath === "." ? "index" : subpath.slice(2).replace(/\//g, "__")}.${isModule ? "mjs" : "cjs"}`;
    exportsMap[subpath] = file;
    let body;
    if (isModule) {
      const probe = join(dir, "__probe.mjs");
      writeFileSync(probe, `export const ns = await import(${JSON.stringify(specifier)});\n`);
      const { ns } = await import(pathToFileURL(probe).href);
      unlinkSync(probe);
      body = `export * from ${JSON.stringify(specifier)};\n${"default" in ns ? `export { default } from ${JSON.stringify(specifier)};\n` : ""}`;
    } else {
      body = `module.exports = require(${JSON.stringify(specifier)});\n`;
    }
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `// ${MARKER}: re-exports ${specifier} from app/node_modules\n${body}`);
  }
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({
    name: id,
    version: "0.0.0",
    private: true,
    description: `${MARKER} for ${real}`,
    ...(isModule ? { type: "module" } : {}),
    exports: exportsMap,
  }, null, 2)}\n`);
  console.log(`[pi-web] ${id} -> ${real} (${Object.keys(exportsMap).join(", ")})`);
}
