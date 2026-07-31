// H-4 gate: every bare import specifier must be declared in the nearest package.json.
//
// The hole this closes: a file imports a package that is in no manifest and no lockfile.
// `node --test` then dies with ERR_MODULE_NOT_FOUND — a LOAD failure, zero assertion failures,
// and a CI step that reads as a suite that ran. The gate is static: it reads the tracked script
// surface and the manifests, never installed node_modules, so a stale local install cannot make
// it green.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// `import x from "p"`, `export * from "p"`, `import("p")`, `require("p")`, bare `import "p";` —
// all reduce to a quoted specifier in a position ordinary prose does not occupy.
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[\s\S]{0,400}?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|[;{}\n])\s*import\s+["']([^"']+)["']\s*;/gm,
];

const PACKAGE_NAME = /^(@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*$/;

function packageName(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function declaredIn(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

// Nearest manifest wins: tools/npm/minimatch-callable-compat declares `minimatch-modern`
// locally, and resolving that file against the root manifest would report a false finding.
function nearestDeclarations(root, file, cache) {
  let directory = dirname(resolve(root, file));
  const stop = resolve(root);
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      if (!cache.has(manifestPath)) cache.set(manifestPath, declaredIn(manifestPath));
      return cache.get(manifestPath);
    }
    if (directory === stop || dirname(directory) === directory) return new Set();
    directory = dirname(directory);
  }
}

function lineOf(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (source[cursor] === "\n") line += 1;
  return line;
}

// ponytail: quote parity, not a JS tokenizer. A match whose line begins a comment, or which is
// preceded on its line by an odd number of quotes, is text about an import rather than one —
// which is how this file's own header comment and the test fixtures' inline sources read. Both
// misjudgements fail RED (a spurious finding), never green, except for a real import preceded on
// the same line by an unbalanced quote. Upgrade path if that ever appears: a real string/comment
// mask over the source.
function isQuotedOrCommented(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const before = source.slice(lineStart, index);
  if (/^\s*(\/\/|\/?\*)/.test(before)) return true;
  return (before.match(/["'`]/g) ?? []).length % 2 === 1;
}

/**
 * @param {string} root repository root to scan
 * @returns {{ scanned: number, findings: { file: string, line: number, specifier: string }[] }}
 */
export function evaluateUndeclaredImports(root) {
  const listed = execFileSync("git", ["-C", root, "ls-files", "--", "*.mjs", "*.js", "*.cjs"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = listed.split("\n").filter(Boolean).filter((file) => !file.split(sep).includes("node_modules"));
  const manifests = new Map();
  const findings = [];

  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    const declared = nearestDeclarations(root, file, manifests);
    const seen = new Set();
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
        if (isQuotedOrCommented(source, match.index)) continue;
        const name = packageName(specifier);
        // A specifier that is not a legal package name is prose caught by a loose regex, not a
        // dependency. False findings get allowlisted, and an allowlist is how a gate dies.
        if (!PACKAGE_NAME.test(name) || declared.has(name) || seen.has(name)) continue;
        seen.add(name);
        findings.push({ file, line: lineOf(source, match.index), specifier: name });
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.specifier.localeCompare(b.specifier));
  return { scanned: files.length, findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
  const { scanned, findings } = evaluateUndeclaredImports(root);
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: imports "${finding.specifier}", `
      + "which no package.json above it declares");
  }
  if (findings.length > 0) {
    console.error(`undeclared imports gate FAILED: ${findings.length} undeclared specifier(s) across ${scanned} files`);
    process.exit(1);
  }
  console.log(`undeclared imports gate passed (${scanned} file${scanned === 1 ? "" : "s"} scanned)`);
}
