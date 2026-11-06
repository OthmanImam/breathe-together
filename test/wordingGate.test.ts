import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Wording gate (Phase 2 hard rule): no medical-decision language anywhere in
 * shipped text — code, comments, UI strings, docs. The ONLY sanctioned
 * occurrences are:
 *  - the mandated disclaimer ("Not a medical device. Not for diagnosis or
 *    treatment.") — matched by the allowlist below;
 *  - the FORBIDDEN_TERMS list literal inside src/coach/summary.ts (the gate
 *    itself), which is not user-facing copy.
 *
 * Matching is word-boundary + stem, case-insensitive, so ordinary verbs are
 * fine ("handle it as a sample") but medical framing is not.
 */

const BANNED =
  /\b(diagnos\w*|treat|treats|treated|treating|treatment|cure|cures|cured|curing|stress level|anxiety|heart health|clinical|fda)\b/i;

const MANDATED_DISCLAIMER = /not (a medical device|for diagnosis or treatment)/i;
const TERM_LIST_LITERAL = /^[\s*"']*(diagnos|treat|cure|stress level|anxiety|heart health|clinical|fda)["',\s]*$/;

const ROOTS = ["src", "docs", "public"];
const ROOT_FILES = ["README.md", ".env.example"];
const SKIPPED_DIRS = new Set(["node_modules", "public/assets", "dist", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(process.cwd(), full).replaceAll(path.sep, "/");
    if (SKIPPED_DIRS.has(rel) || SKIPPED_DIRS.has(path.basename(full))) continue;
    if (statSync(full).isDirectory()) {
      if (rel === "public/assets") continue;
      yield* walk(full);
    } else if (/\.(ts|md|html|css|js|json)$/.test(name)) {
      yield rel;
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) {
    files.push(...walk(path.join(process.cwd(), root)));
  }
  for (const f of ROOT_FILES) {
    try {
      statSync(path.join(process.cwd(), f));
      files.push(f);
    } catch {
      // Optional files (README always exists in this repo).
    }
  }
  return [...new Set(files)];
}

test("wording gate: no reserved medical vocabulary outside the mandated disclaimer", () => {
  const violations: string[] = [];
  for (const file of collectFiles()) {
    const lines = readFileSync(path.join(process.cwd(), file), "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (!BANNED.test(line)) return;
      if (MANDATED_DISCLAIMER.test(line)) return;
      if (file === "src/coach/summary.ts" && TERM_LIST_LITERAL.test(line)) return;
      violations.push(`${file}:${idx + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    violations,
    [],
    `wording violations:\n${violations.join("\n")}`,
  );
});
