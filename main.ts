// mend: one patch tool for every AI edit format. SPEC.md is the whole contract.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, the
// V4A patch format, JSON edits), finds the lines each edit names at the first of
// three matching tiers (exact; trailing whitespace; leading and trailing
// whitespace with re-indentation), and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.
//
// Two readings of SPEC.md that this file relies on, written down so they are
// not lost:
// (1) SPEC section 6 says "empty lines" at the end of a unified hunk body are
// not part of it, while section 8 says "Blank lines" at the end of a V4A
// section are not part of it, and section 4 defines a blank line as one that
// is empty OR only whitespace. A line holding a single space is therefore
// blank but not empty: it is kept at the end of a unified hunk body (it is a
// real context line with empty text) and trimmed at the end of a V4A section.
// (2) For a V4A chunk anchored to the end of the file, section 5 still finds
// the tier from any occurrence of the old text first, and section 8 then
// filters that tier's occurrences to the ones ending at the file's last line;
// if none of them ends there the chunk fails instead of falling through to a
// later tier.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse failure: exit 2 with this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: exit 1, one `error: <code> <path>` line. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at `\n`, one trailing `\r` off each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. `moves` holds the move edits that succeeded, as [old, new] pairs, for the `R` output lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Section 5: matching lines, and section 3: a file's lines and line break.
// ---------------------------------------------------------------------------

/** A file as lines plus its own line break and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

/** Split a file's text at its own line break (CRLF when its first line feed follows a carriage return, LF otherwise). */
function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** Write a file back: its own line break between its lines, and a final one exactly when it ended with one. A file of no lines is written empty. */
function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

const leadWs = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Two lines equal at one tier: 0 exact, 1 trailing spaces and tabs off both, 2 leading and trailing spaces and tabs off both. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return stripWs(a) === stripWs(b);
}

/** Every 0-based position where O's lines match the file's lines at one tier; occurrences may overlap. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once, with every occurrence at it. Null when O occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, o, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** As findTier, but only occurrences at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line target, at the first tier where one is. Null when there is none. */
function findLineAtOrAfter(lines: string[], target: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, target, t)) return i;
    }
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, -1 when it is a new line. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * The lines that replace a matched O at `pos`: a context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other line of N is
 * re-indented: F is the leading spaces and tabs of the file's first matched line
 * and P those of O's first line; a line that is not empty and not only whitespace,
 * and starts with P, has that P replaced by F; any other line is written as it is.
 * At tiers 0 and 1 the lines of N are written as they are.
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = tier === 2 ? leadWs(fileLines[pos]!) : '';
  const p = tier === 2 ? leadWs(o[0]!) : '';
  return n.map((line) => {
    if (line.ctx >= 0) return fileLines[pos + line.ctx]!;
    if (tier === 2 && line.text !== '' && line.text.trim() !== '' && line.text.startsWith(p)) return f + line.text.slice(p.length);
    return line.text;
  });
}

/** The same re-indentation for a format with no context lines (SEARCH/REPLACE): every line of N is re-indented at tier 2. */
function reindentNew(lines: string[], fileFirst: string, oFirst: string, tier: number): string[] {
  if (tier !== 2) return lines;
  const f = leadWs(fileFirst);
  const p = leadWs(oFirst);
  return lines.map((t) => (t !== '' && t.trim() !== '' && t.startsWith(p) ? f + t.slice(p.length) : t));
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, renderFile({ lines, br: doc.br, final: doc.final }));
    };
  }
  return null;
}

/** The patch's JSON edits: either one JSON array of edit objects, or JSON Lines with one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

/** One body line of a hunk: context, old, new, or a `\` line. `rawEmpty` marks a context line written as a literally empty line. */
type BodyItem =
  | { kind: 'ctx'; text: string; rawEmpty: boolean }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'bs' };

interface Hunk {
  /** The hunk header's old start A. */
  a: number;
  body: BodyItem[];
}

interface RawSection {
  headerOld: string | null;
  headerNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A hunk header `@@ -A[,B] +C[,D] @@`, optionally followed by text. B and D are not used. Any other line starting with `@@` is a parse error at its line. */
function parseHunkHeader(line: string, i: number): number {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1]!, 10);
}

/** The body of a hunk: lines starting with ` `, `-`, `+` or `\`, or empty lines (an empty line is a context line whose text is empty). It ends at the first other line, at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the end of the patch. Empty lines at the end of a body are not part of it. */
function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const body: BodyItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '', rawEmpty: true });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: line.slice(1), rawEmpty: false });
      i += 1;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: line.slice(1) });
      i += 1;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: line.slice(1) });
      i += 1;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs' });
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.rawEmpty) body.pop();
    else break;
  }
  return { hunk: { a: 0, body }, next: i };
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters, up to the first tab, with surrounding spaces removed, and a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A `diff --git a/<X> b/<Y>` line's two paths, or a parse error at its line when it is not of that form. */
function diffGitPaths(line: string, i: number): [string, string] {
  const m = line.match(/^diff --git a\/(\S+) b\/(\S+)\s*$/);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return [m[1]!, m[2]!];
}

function newRawSection(): RawSection {
  return { headerOld: null, headerNew: null, renameOld: null, renameNew: null, diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [] };
}

/** The patch's unified sections. Outside bodies, lines that are not part of a section header are ignored. */
function parseUnified(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (sec: RawSection): void => {
    sections.push(sec);
    cur = sec;
    inHeader = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = diffGitPaths(line, i);
      const sec = newRawSection();
      sec.diffOld = x;
      sec.diffNew = y;
      startSection(sec);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const sec = newRawSection();
        sec.headerOld = headerPath(line);
        sec.headerNew = headerPath(lines[i + 1]!);
        startSection(sec);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { hunk, next } = parseHunkBody(lines, i + 1);
        hunk.a = a;
        cur.hunks.push(hunk);
        inHeader = false;
        i = next;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.headerOld = headerPath(line);
          cur.headerNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i);
      const { hunk, next } = parseHunkBody(lines, i + 1);
      hunk.a = a;
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = newRawSection();
      sec.headerOld = headerPath(line);
      sec.headerNew = headerPath(lines[i + 1]!);
      startSection(sec);
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** A section's old and new paths: the `---`/`+++` pair names them, else `rename from`/`rename to`, else the `diff --git` paths. `/dev/null` means no file. */
function sectionPaths(sec: RawSection): { oldP: string | null; newP: string | null } {
  const oldRaw = sec.headerOld ?? sec.renameOld ?? sec.diffOld;
  const newRaw = sec.headerNew ?? sec.renameNew ?? sec.diffNew;
  return { oldP: oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw, newP: newRaw === null || newRaw === '/dev/null' ? null : newRaw };
}

/** A hunk's O (context and `-` lines) and N (context and `+` lines), each in body order. */
function hunkON(hunk: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const item of hunk.body) {
    if (item.kind === 'ctx') {
      o.push(item.text);
      n.push({ text: item.text, ctx: o.length - 1 });
    } else if (item.kind === 'old') {
      o.push(item.text);
    } else if (item.kind === 'new') {
      n.push({ text: item.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastCtxOrNew(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
    const item = hunk.body[k]!;
    if (item.kind === 'ctx' || item.kind === 'new') {
      return k + 1 < hunk.body.length && hunk.body[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Whether a `\` line follows a creation's last `+` line, across all its hunks. */
function creationEndsWithoutBreak(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h -= 1) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k -= 1) {
      if (body[k]!.kind === 'new') return k + 1 < body.length && body[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Apply one hunk to a file: O is replaced by N, at the occurrence nearest to A - 1 + d (of two equally near, the earlier), or, when O is empty, N is inserted after the first A + d lines. */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): FileDoc {
  const { o, n } = hunkON(hunk);
  if (o.length === 0 && n.length === 0) return doc;
  if (o.length === 0) {
    const at = Math.min(Math.max(hunk.a + d, 0), doc.lines.length);
    const newLines = [...doc.lines.slice(0, at), ...n.map((x) => x.text), ...doc.lines.slice(at)];
    const final = at === doc.lines.length ? !backslashAfterLastCtxOrNew(hunk) : doc.final;
    return { lines: newLines, br: doc.br, final };
  }
  const found = findTier(doc.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.positions[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      pos = p;
      best = dist;
    }
  }
  const replacement = buildReplacement(doc.lines, pos, o, n, found.tier);
  const newLines = [...doc.lines.slice(0, pos), ...replacement, ...doc.lines.slice(pos + o.length)];
  const final = pos + o.length === doc.lines.length ? !backslashAfterLastCtxOrNew(hunk) : doc.final;
  return { lines: newLines, br: doc.br, final };
}

/** One unified section as one edit. */
function unifiedEdit(sec: RawSection, strict: boolean): Edit {
  const { oldP, newP } = sectionPaths(sec);
  const isCreate = sec.newFile || oldP === null;
  const isDelete = !isCreate && (sec.deletedFile || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const item of h.body) if (item.kind === 'new') plus.push(item.text);
      const text = plus.length === 0 ? '' : plus.join('\n') + (creationEndsWithoutBreak(sec.hunks) ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', '/dev/null');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove) {
      if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
      if (!safe(newP!)) throw new Fail('unsafe', newP!);
      const cur = tree.get(oldP!);
      if (cur === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      let doc = parseFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const { o, n } = hunkON(h);
        doc = applyHunk(doc, h, d, strict, oldP!);
        d += n.length - o.length;
      }
      tree.now.set(newP!, renderFile(doc));
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
    const cur = tree.get(oldP!);
    if (cur === null) throw new Fail('missing', oldP!);
    let doc = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = hunkON(h);
      doc = applyHunk(doc, h, d, strict, oldP!);
      d += n.length - o.length;
    }
    tree.now.set(oldP!, renderFile(doc));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

/** One SEARCH/REPLACE block as one edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseFile(cur);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const rep = reindentNew(newLines, doc.lines[pos]!, oldLines[0]!, found.tier);
    const lines = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile({ lines, br: doc.br, final: doc.final }));
  };
}

/** The patch's SEARCH/REPLACE blocks, in order. Lines outside blocks are otherwise ignored. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let end = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (sep < 0 && t === '=======') {
        sep = j;
        continue;
      }
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** The anchor text after `@@`, or null for no anchor (empty text, or the first chunk starting at a body line). */
  anchor: string | null;
  body: string[];
  eof: boolean;
}

/** A V4A section's lines (with their 0-based line numbers) from `start` up to the next section start or `last` (the `*** End Patch` line, exclusive). Blank lines at the end of a section are not part of it. */
function collectV4aSection(lines: string[], start: number, last: number): { items: Array<{ text: string; idx: number }>; next: number } {
  let end = start;
  while (end < last) {
    const l = lines[end]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    end += 1;
  }
  const items: Array<{ text: string; idx: number }> = [];
  for (let k = start; k < end; k += 1) items.push({ text: lines[k]!, idx: k });
  while (items.length > 0 && blank(items[items.length - 1]!.text)) items.pop();
  return { items, next: end };
}

/** One V4A Add File section as one edit: the file is the section's lines, ended by a line break. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section as one edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** A V4A chunk's O (context and `-` lines) and N (context and `+` lines). */
function v4aChunkON(chunk: V4aChunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const line of chunk.body) {
    if (line === '' || line.startsWith(' ')) {
      const text = line === '' ? '' : line.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      n.push({ text: line.slice(1), ctx: -1 });
    }
  }
  return { o, n };
}

/** One V4A Update File section as one edit: its chunks apply in order, with a cursor that starts at line 0. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findLineAtOrAfter(doc.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = v4aChunkON(chunk);
      if (o.length === 0) {
        const at = chunk.eof ? doc.lines.length : cursor;
        const lines = [...doc.lines.slice(0, at), ...n.map((x) => x.text), ...doc.lines.slice(at)];
        doc = { lines, br: doc.br, final: doc.final };
        cursor = at + n.length;
        continue;
      }
      const found = findTierFrom(doc.lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let pos = found.positions[0]!;
      if (chunk.eof) {
        const atEnd = found.positions.filter((p) => p + o.length === doc.lines.length);
        if (atEnd.length === 0) throw new Fail('no-match', path);
        pos = atEnd[0]!;
      }
      const replacement = buildReplacement(doc.lines, pos, o, n, found.tier);
      const lines = [...doc.lines.slice(0, pos), ...replacement, ...doc.lines.slice(pos + o.length)];
      doc = { lines, br: doc.br, final: doc.final };
      cursor = pos + replacement.length;
    }
    const text = renderFile(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** The patch's V4A sections as edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const { items, next } = collectV4aSection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const item of items) {
        if (item.text.startsWith('+')) fileLines.push(item.text.slice(1));
        else if (item.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${item.idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const { items, next } = collectV4aSection(lines, i + 1, last);
      if (items.length > 0) throw new Exit2(`error: parse ${items[0]!.idx + 1}`);
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      const { items, next } = collectV4aSection(lines, i + 1, last);
      let moveTo: string | null = null;
      let rest = items;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (const item of rest) {
        const text = item.text;
        if (text.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          continue;
        }
        if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${item.idx + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          continue;
        }
        if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
          if (cur === null) {
            if (chunks.length !== 0) throw new Exit2(`error: parse ${item.idx + 1}`);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(text);
          continue;
        }
        throw new Exit2(`error: parse ${item.idx + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format.
// ---------------------------------------------------------------------------

/** With `--format=auto` the format is the first of these that holds. Null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output and exit codes, order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded is one `R <old> -> <new>` line, when <old> existed before the patch and does not after it, and <new> did not exist before it and does after it. It replaces that pair's `D` and `A` lines and sorts by `<new>`.
  const rMoves: Array<[string, string]> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) rMoves.push([oldP, newP]);
  }
  const rOlds = new Set(rMoves.map((m) => m[0]));
  const rNews = new Set(rMoves.map((m) => m[1]));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!rOlds.has(p) && !rNews.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [oldP, newP] of rMoves) rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
