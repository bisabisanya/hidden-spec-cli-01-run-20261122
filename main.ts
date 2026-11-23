// main.ts is mend, the CLI SPEC.md specifies. It applies an edit that an AI model wrote to a tree of text files,
// in four formats: unified diffs, SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old path, new path) pairs, for the `R` output lines. */
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
// Files, lines and three-tier matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

/** A file's text as lines, its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** The tier at which two lines are equal (0 exact, 1 trailing ws ignored, 2 both ends ignored), or null. */
function lineTier(a: string, b: string): number | null {
  if (a === b) return 0;
  if (trailTrim(a) === trailTrim(b)) return 1;
  if (trimWs(a) === trimWs(b)) return 2;
  return null;
}

/** Every 0-based position where O matches the file's lines at tier `tier` or better. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      const t = lineTier(o[j]!, file[i + j]!);
      if (t === null || t > tier) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) at which O occurs, with its positions. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const occ = occurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of the replacement text: a `+` line, or a context line naming its index in O. */
interface NEntry {
  text: string;
  ctx: number | null;
}

/**
 * Render the replacement lines for a match at position `pos`: context lines are the file's own matched lines,
 * other lines are written as they are, re-indented at tier 2 (section 5).
 */
function renderN(n: NEntry[], file: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadWs(file[pos]!);
    const p = leadWs(o[0]!);
    for (const e of n) {
      if (e.ctx !== null) {
        out.push(file[pos + e.ctx]!);
      } else if (e.text !== '' && !/^[ \t]+$/.test(e.text) && e.text.startsWith(p)) {
        out.push(f + e.text.slice(p.length));
      } else {
        out.push(e.text);
      }
    }
    return out;
  }
  for (const e of n) out.push(e.ctx !== null ? file[pos + e.ctx]! : e.text);
  return out;
}

/** Replace `count` lines at `pos` of the state's lines with `ins` (the state's break and final flag untouched). */
function spliceState(st: FileState, pos: number, count: number, ins: string[]): FileState {
  const lines = [...st.lines];
  lines.splice(pos, count, ...ins);
  return { lines, br: st.br, final: st.final };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start line A (1-based, 0 for a pure insertion at the top). */
  a: number;
  /** Body lines: ' ' context, '-' old, '+' new, '\' no-newline marker, '' empty context. */
  body: string[];
}

/** The `+` lines of a hunk, and whether a `\` line follows its last context or `+` line. */
function hunkPlus(h: Hunk): { plus: string[]; noEol: boolean; hasPlus: boolean } {
  const plus: string[] = [];
  let lastCtx = -1;
  h.body.forEach((l, i) => {
    if (l.startsWith('+')) plus.push(l.slice(1));
    if (l.startsWith(' ') || l === '' || l.startsWith('+')) lastCtx = i;
  });
  const noEol = lastCtx >= 0 && h.body[lastCtx + 1] !== undefined && h.body[lastCtx + 1]!.startsWith('\\');
  return { plus, noEol, hasPlus: plus.length > 0 };
}

/** O (context and `-` lines) and N (context and `+` lines, context lines naming their index in O). */
function hunkON(h: Hunk): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const l of h.body) {
    if (l.startsWith(' ') || l === '') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
    }
  }
  return { o, n };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(.*?) b\/(.*)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- `/`+++ `: text after the four characters, up to the first tab, spaces removed. */
function dashPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return '/dev/null';
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  /** In a section header (before its first hunk), in a hunk body, or between hunks. */
  let mode: 'out' | 'head' | 'body' | 'between' = 'out';
  let hunk: Hunk | null = null;
  /** Whether the current section's header already took a `---`/`+++` pair. */
  let tookPair = false;

  const endBody = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur.hunks.push(hunk);
      hunk = null;
    }
    if (mode === 'body') mode = 'between';
  };
  const endSection = (): void => {
    endBody();
    cur = null;
    mode = 'out';
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, create: false, remove: false, hunks: [] };
    sections.push(cur);
    mode = 'head';
    tookPair = false;
  };
  const startHunk = (line: string, idx: number): void => {
    if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
    const m = HUNK_HEAD.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    hunk = { a: Number(m[1]), body: [] };
    mode = 'body';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endSection();
      startSection(m[1]!, m[2]!);
      continue;
    }
    if (mode === 'body') {
      // The body ends at a `--- ` line followed by a `+++ ` line, even though it starts with `-`.
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk!.body.push(line);
        continue;
      } else {
        endBody();
      }
      // Fall through to handle the line that ended the body.
    }
    if (line.startsWith('@@')) {
      startHunk(line, i);
      continue;
    }
    if (line.startsWith('--- ') && mode !== 'body') {
      const next = lines[i + 1] ?? '';
      if (!next.startsWith('+++ ')) {
        if (mode === 'head') throw new Exit2(`error: parse ${i + 2}`);
        continue; // prose outside a section header
      }
      if (mode === 'out' || mode === 'between') {
        endSection();
        startSection(null, null);
      }
      // A `---`/`+++` pair in a header names the old and new path.
      cur!.oldPath = dashPath(line) === '/dev/null' ? null : dashPath(line);
      cur!.newPath = dashPath(next) === '/dev/null' ? null : dashPath(next);
      tookPair = true;
      i += 1;
      continue;
    }
    if (mode === 'head' && cur !== null) {
      if (line.startsWith('+++ ')) continue; // a lone `+++` line names nothing on its own
      if (line.startsWith('rename from ')) {
        if (!tookPair) cur.oldPath = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!tookPair) cur.newPath = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        continue;
      }
      continue; // index, old/new mode, similarity, Index: and any other header line
    }
    // Outside bodies and headers: prose, code fences and stray lines are ignored.
  }
  endSection();

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one hunk of a section to the working file, updating its final line break (section 6). */
function applyUnifiedHunk(st: FileState, h: Hunk, d: number, path: string, strict: boolean): FileState {
  const { o, n } = hunkON(h);
  const { noEol } = hunkPlus(h);
  if (o.length === 0) {
    const ins = n.map((e) => e.text);
    if (ins.length === 0) return st;
    const pos = Math.min(Math.max(h.a + d, 0), st.lines.length);
    const atEnd = pos === st.lines.length;
    const out = spliceState(st, pos, 0, ins);
    return { ...out, final: atEnd ? !noEol : st.final };
  }
  const found = findTier(st.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const runsToEnd = best + o.length === st.lines.length;
  const ins = renderN(n, st.lines, best, o, found.tier);
  const out = spliceState(st, best, o.length, ins);
  if (!runsToEnd) return out;
  return { ...out, final: n.length > 0 ? !noEol : true };
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    // Every path the edit names is checked for safety before anything else about it.
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = s.create || oldP === null;
    const isRemove = s.remove || newP === null;
    if (isCreate && isRemove) return; // both ends /dev/null: nothing to do
    if (isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        const hp = hunkPlus(h);
        plus.push(...hp.plus);
        if (hp.hasPlus) noEol = hp.noEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isRemove) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    if (isMove) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let st = splitFile(tree.get(oldP)!);
      let d = 0;
      for (const h of s.hunks) {
        const { o, n } = hunkON(h);
        st = applyUnifiedHunk(st, h, d, oldP, strict);
        d += n.length - o.length;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(st));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = (oldP ?? newP)!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    let st = splitFile(tree.get(p)!);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n } = hunkON(h);
      st = applyUnifiedHunk(st, h, d, p, strict);
      d += n.length - o.length;
    }
    tree.now.set(p, joinFile(st));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_SEP = '=======';
const SR_END = '>>>>>>> REPLACE';

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== SR_SEARCH) continue;
    const searchLine = i;
    // The path: the nearest line before the SEARCH line, after the previous block, that is not blank
    // and does not start with three backticks once its surrounding whitespace is removed.
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    // Find `=======` then `>>>>>>> REPLACE` after the SEARCH line.
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === SR_SEARCH) break;
      if (lines[j]!.trimEnd() === SR_SEP) {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === SR_SEARCH) break;
      if (lines[j]!.trimEnd() === SR_END) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NEntry[] = newLines.map((t) => ({ text: t, ctx: null }));
    const ins = renderN(n, st.lines, pos, oldLines, found.tier);
    tree.now.set(path, joinFile(spliceState(st, pos, oldLines.length, ins)));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NEntry[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
  /** 1-based line number of the section's `*** Update File:` line (for its parse error). */
  updateLine: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path, moveTo: null, chunks: [], updateLine: i + 1 };
    sections.push(sec);
    i += 1;
    // Collect the section's raw lines (up to the next section start or `*** End Patch`).
    const raw: number[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(i);
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    parseVSection(sec, lines, raw, i);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

/** Interpret one V4A section's raw lines (already stripped of trailing blanks). */
function parseVSection(sec: VSection, lines: string[], raw: number[], _after: number): void {
  if (sec.kind === 'add') {
    const body: string[] = [];
    for (const idx of raw) {
      const l = lines[idx]!;
      if (l.startsWith('+')) body.push(l.slice(1));
      else if (l === '') body.push('');
      else throw new Exit2(`error: parse ${idx + 1}`);
    }
    sec.chunks.push({ anchor: null, eof: false, o: [], n: body.map((t) => ({ text: t, ctx: null })) });
    return;
  }
  if (sec.kind === 'delete') {
    for (const idx of raw) {
      if (!blank(lines[idx]!)) throw new Exit2(`error: parse ${idx + 1}`);
    }
    return;
  }
  // Update File: optional `*** Move to:` first line, then chunks.
  let k = 0;
  if (k < raw.length && lines[raw[k]!]!.startsWith('*** Move to: ')) {
    sec.moveTo = lines[raw[k]!]!.slice('*** Move to: '.length).trim();
    k += 1;
  }
  let chunk: VChunk | null = null;
  const closeChunk = (): void => {
    if (chunk !== null) {
      sec.chunks.push(chunk);
      chunk = null;
    }
  };
  let firstChunk = true;
  for (; k < raw.length; k += 1) {
    const idx = raw[k]!;
    const l = lines[idx]!;
    if (l.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: l.slice(2).trim(), eof: false, o: [], n: [] };
      firstChunk = false;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${idx + 1}`);
      chunk.eof = true;
      closeChunk();
      firstChunk = false;
      continue;
    }
    if (l.startsWith(' ') || l === '' || l.startsWith('-') || l.startsWith('+')) {
      if (chunk === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${idx + 1}`);
        chunk = { anchor: null, eof: false, o: [], n: [] };
        firstChunk = false;
      }
      if (l.startsWith(' ') || l === '') {
        const t = l === '' ? '' : l.slice(1);
        chunk.o.push(t);
        chunk.n.push({ text: t, ctx: chunk.o.length - 1 });
      } else if (l.startsWith('-')) {
        chunk.o.push(l.slice(1));
      } else {
        chunk.n.push({ text: l.slice(1), ctx: null });
      }
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  closeChunk();
  if (sec.chunks.length === 0 && sec.moveTo === null) {
    throw new Exit2(`error: parse ${sec.updateLine}`);
  }
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const body = s.chunks[0]!.n.map((e) => e.text);
      tree.now.set(s.path, body.length === 0 ? '' : body.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let st = splitFile(before);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        // First line at or after the cursor equal to the anchor, at the first tier with one.
        let at = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && at < 0; t += 1) {
          for (let j = cursor; j < st.lines.length; j += 1) {
            const lt = lineTier(c.anchor, st.lines[j]!);
            if (lt !== null && lt <= t) {
              at = j;
              break;
            }
          }
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      if (c.o.length === 0) {
        const pos = c.eof ? st.lines.length : cursor;
        const ins = c.n.map((e) => e.text);
        st = spliceState(st, pos, 0, ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findTierFrom(st.lines, c.o, cursor, strict, c.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const ins = renderN(c.n, st.lines, found.pos, c.o, found.tier);
      st = spliceState(st, found.pos, c.o.length, ins);
      cursor = found.pos + ins.length;
    }
    const out = joinFile(st);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

/**
 * The first occurrence of O at or after `from`, at the first tier with one; an end-of-file chunk takes only an
 * occurrence that ends at the file's last line.
 */
function findTierFrom(file: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const occ = occurrences(file, o, t).filter((p) => p >= from && (!eof || p + o.length === file.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command line, output and exit codes (SPEC.md sections 1, 2 and 10)
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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per changed path, in byte order of the paths; a successful move is one `R` line that
  // replaces its `D` and `A` lines and sorts by its new path.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
