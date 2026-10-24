import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    audio: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    delay: { type: "string" },
  },
});
if (values.server === undefined) {
  console.error(
    "usage: node scripts/writing-eval/run.mjs --server <url> [--audio <dir>] [--out <file>] [--only dictation|correction] [--delay ms]",
  );
  process.exit(2);
}
const server = values.server.replace(/\/$/u, "");
const delayMs = Number(values.delay ?? "0");
const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));
const dataset = JSON.parse(
  await readFile(new URL("./dataset.json", import.meta.url), "utf8"),
);

function words(text) {
  return (
    text
      .toLowerCase()
      .replace(/(^|\s)\d{1,2}[.)](?=\s)/gu, " ")
      .match(/[\p{L}\p{N}'’]+/gu) ?? []
  );
}

function wordErrorRate(hypothesis, reference) {
  const h = words(hypothesis);
  const r = words(reference);
  const row = Array.from({ length: h.length + 1 }, (_, index) => index);
  for (let i = 1; i <= r.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= h.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return r.length === 0 ? 0 : row[h.length] / r.length;
}

function percentile(list, fraction) {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ];
}

async function post(path, init) {
  const started = performance.now();
  const response = await fetch(`${server}/api/v1${path}`, {
    method: "POST",
    ...init,
  });
  const body = await response.json();
  return {
    status: response.status,
    body,
    ms: Math.round(performance.now() - started),
  };
}

async function runDictation(audioDir) {
  const results = [];
  for (const item of dataset.dictation) {
    await pause();
    const audio = await readFile(join(audioDir, `${item.id}.wav`));
    const form = new FormData();
    form.set(
      "file",
      new File([audio], `${item.id}.wav`, { type: "audio/wav" }),
    );
    form.set("context", "");
    const { status, body, ms } = await post(
      "/writing-assistance/dictation-segments",
      {
        body: form,
      },
    );
    if (status !== 200) {
      results.push({ id: item.id, status, error: body, ms });
      continue;
    }
    const text = body.text.toLowerCase();
    const missing = item.mustKeep.filter((word) => !words(text).includes(word));
    const list = /^\s*\d{1,2}[.)]\s/mu.test(body.text);
    results.push({
      id: item.id,
      status,
      ms,
      formatted: body.formatted,
      raw: body.raw,
      text: body.text,
      rawWer: Number(wordErrorRate(body.raw, item.reference).toFixed(3)),
      textWer: Number(wordErrorRate(body.text, item.reference).toFixed(3)),
      missingKeyWords: missing,
      listOk: list === item.expectList,
    });
  }
  return results;
}

function letters(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function applyEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

function forbiddenSpans(text, forbidden) {
  const spans = [];
  for (const token of forbidden) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{N}_])`,
      "gu",
    );
    for (const match of text.matchAll(pattern)) {
      spans.push([match.index, match.index + match[0].length, token]);
    }
  }
  return spans;
}

async function runCorrection() {
  const results = [];
  for (const item of dataset.correction) {
    await pause();
    const { status, body, ms } = await post("/writing-assistance/corrections", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: item.text, context: "", complete: true }),
    });
    if (status !== 200 || body.status !== "ok") {
      results.push({ id: item.id, status, skipped: body, ms });
      continue;
    }
    const applied = body.edits.filter((edit) => edit.disposition === "apply");
    const suggested = body.edits.filter(
      (edit) => edit.disposition === "suggest",
    );
    const spans = forbiddenSpans(item.text, item.forbidden);
    const touched = applied.filter((edit) =>
      spans.some(([start, end]) => edit.start < end && edit.end > start),
    );
    const harmful = touched.filter(
      (edit) => letters(edit.original) !== letters(edit.replacement),
    );
    const result = applyEdits(item.text, applied);
    const fixedIn = (text) =>
      item.expectFixed.filter(
        ([original, replacement]) =>
          forbiddenSpans(text, [original]).length <
            forbiddenSpans(item.text, [original]).length &&
          text.includes(replacement),
      );
    const appliedFixes = fixedIn(result);
    const found = fixedIn(applyEdits(item.text, body.edits));
    results.push({
      id: item.id,
      status,
      ms,
      result,
      applied: applied.map((edit) => `${edit.original} → ${edit.replacement}`),
      suggested: suggested.map(
        (edit) => `${edit.original} → ${edit.replacement}`,
      ),
      harmful: harmful.map((edit) => `${edit.original} → ${edit.replacement}`),
      caseOnlyOnProtected: touched
        .filter((edit) => !harmful.includes(edit))
        .map((edit) => `${edit.original} → ${edit.replacement}`),
      expectedFound: found.length,
      expectedApplied: appliedFixes.length,
      expectedTotal: item.expectFixed.length,
    });
  }
  return results;
}

const report = { server, startedAt: new Date().toISOString() };
if (values.only !== "correction") {
  if (values.audio === undefined) {
    console.error("--audio is required for dictation");
    process.exit(2);
  }
  const dictation = await runDictation(values.audio);
  const ok = dictation.filter((item) => item.status === 200);
  report.dictation = {
    cases: dictation,
    summary: {
      cases: dictation.length,
      failedRequests: dictation.length - ok.length,
      meanRawWer: Number(
        (ok.reduce((sum, item) => sum + item.rawWer, 0) / ok.length).toFixed(3),
      ),
      meanTextWer: Number(
        (ok.reduce((sum, item) => sum + item.textWer, 0) / ok.length).toFixed(
          3,
        ),
      ),
      formatted: ok.filter((item) => item.formatted).length,
      keptRaw: ok.filter((item) => !item.formatted).length,
      lostKeyWords: ok
        .filter((item) => item.missingKeyWords.length > 0)
        .map((item) => item.id),
      listMismatches: ok.filter((item) => !item.listOk).map((item) => item.id),
      p50Ms: percentile(
        ok.map((item) => item.ms),
        0.5,
      ),
      p95Ms: percentile(
        ok.map((item) => item.ms),
        0.95,
      ),
    },
  };
}
if (values.only !== "dictation") {
  const correction = await runCorrection();
  const ok = correction.filter(
    (item) => item.status === 200 && item.skipped === undefined,
  );
  report.correction = {
    cases: correction,
    summary: {
      cases: correction.length,
      skipped: correction.length - ok.length,
      harmfulAutoApplies: ok.reduce(
        (sum, item) => sum + item.harmful.length,
        0,
      ),
      caseOnlyTouchesOnProtected: ok.reduce(
        (sum, item) => sum + item.caseOnlyOnProtected.length,
        0,
      ),
      expectedFixesFound: ok.reduce((sum, item) => sum + item.expectedFound, 0),
      expectedFixesApplied: ok.reduce(
        (sum, item) => sum + item.expectedApplied,
        0,
      ),
      expectedFixes: ok.reduce((sum, item) => sum + item.expectedTotal, 0),
      autoApplied: ok.reduce((sum, item) => sum + item.applied.length, 0),
      suggested: ok.reduce((sum, item) => sum + item.suggested.length, 0),
      p50Ms: percentile(
        ok.map((item) => item.ms),
        0.5,
      ),
      p95Ms: percentile(
        ok.map((item) => item.ms),
        0.95,
      ),
    },
  };
}
const output = JSON.stringify(report, null, 2);
if (values.out !== undefined) await writeFile(values.out, output);
console.log(output);
