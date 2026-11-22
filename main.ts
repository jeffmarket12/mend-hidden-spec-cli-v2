import * as fs from 'node:fs';
import * as path from 'node:path';

// --- Types & Small Utilities ---

type PatchFormat = 'unified' | 'search-replace' | 'v4a' | 'json';

interface FileLines {
  lines: string[];
  crlf: boolean;
  hasEndingNewline: boolean;
}

function isSafePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\')) return false;
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function parseFileContent(content: string): FileLines {
  if (content === '') {
    return { lines: [], crlf: false, hasEndingNewline: false };
  }
  let crlf = false;
  const firstLf = content.indexOf('\n');
  if (firstLf > 0 && content[firstLf - 1] === '\r') {
    crlf = true;
  }
  const hasEndingNewline = content.endsWith('\n');
  let trimmed = content;
  if (hasEndingNewline) {
    trimmed = content.slice(0, -1);
    if (crlf && trimmed.endsWith('\r')) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  const sep = crlf ? '\r\n' : '\n';
  const lines = trimmed === '' ? [] : trimmed.split(sep);
  return { lines, crlf, hasEndingNewline };
}

function serializeFileContent(fl: FileLines): string {
  if (fl.lines.length === 0) {
    return '';
  }
  const sep = fl.crlf ? '\r\n' : '\n';
  const body = fl.lines.join(sep);
  return body + (fl.hasEndingNewline ? sep : '');
}

// --- Argument Parsing & CLI & Output Formatting ---

interface ParsedArgs {
  format?: PatchFormat;
  check: boolean;
  strict: boolean;
  patchPath: string | null;
}

function parseCliArgs(args: string[]): { args: ParsedArgs | null; error?: string } {
  let format: PatchFormat | undefined;
  let check = false;
  let strict = false;
  let patchPath: string | null = null;
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      while (i < args.length) {
        positional.push(args[i]);
        i++;
      }
      break;
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (format !== undefined) return { args: null, error: 'duplicate option' };
        const val = arg.slice(9);
        if (val !== 'unified' && val !== 'search-replace' && val !== 'v4a' && val !== 'json' && val !== 'auto') {
          return { args: null, error: 'invalid format' };
        }
        if (val === 'auto') {
          format = undefined;
        } else {
          format = val as PatchFormat;
        }
      } else if (arg === '--check') {
        if (check) return { args: null, error: 'duplicate option' };
        check = true;
      } else if (arg === '--strict') {
        if (strict) return { args: null, error: 'duplicate option' };
        strict = true;
      } else {
        return { args: null, error: 'unknown option' };
      }
    } else {
      positional.push(arg);
    }
    i++;
  }

  if (positional.length > 1) {
    return { args: null, error: 'too many positional args' };
  }
  if (positional.length === 1) {
    patchPath = positional[0];
  }

  return { args: { format, check, strict, patchPath } };
}

interface EditOperation {
  type: 'update' | 'create' | 'delete' | 'move';
  path: string;
  oldPath?: string; // for move
  newPath?: string; // for move
  searchLines?: string[];
  replaceLines?: string[];
  fileText?: string; jsonCmd?: "str_replace" | "insert"; oldStr?: string; newStr?: string; insertLine?: number; // for create / json
  hunks?: any[]; // for unified
  chunks?: Array<{ anchor: string | null; oldLines: string[]; newLines: string[]; endOfFile: boolean }>;
}

interface ApplyResult {
  success: boolean;
  errorCode?: 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';
  errorPath?: string;
}

// --- Patch Format Detection & Unified Diff Parser ---

function detectFormat(text: string): PatchFormat | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {}
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('<<<<<<< SEARCH') || line.startsWith('<<<<<<<') || line.startsWith('<<<<<<< REPLACE')) {
      return 'search-replace';
    }
  }
  for (const line of lines) {
    const t = line.trim();
    if (t === '*** Begin Patch' || t.startsWith('*** Add File:') || t.startsWith('*** Update File:') || t.startsWith('*** Delete File:') || t.startsWith('*** Move to:') || line.startsWith('=== file:') || line.startsWith('=== create:') || line.startsWith('=== delete:') || line.startsWith('=== move:')) {
      return 'v4a';
    }
  }
  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@ ')) {
      return 'unified';
    }
  }
  return null;
}

interface ParseResult {
  edits: EditOperation[];
  error?: { code: string; line: number };
}

function parseUnifiedDiff(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const edits: EditOperation[] = [];
  let i = 0;
  let currentFile: string | null = null;
  let currentHunks: any[] = [];
  let curHunk: any = null;

  while (i < lines.length) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) {
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (curHunk) {
        currentHunks.push(curHunk);
        curHunk = null;
      }
      if (currentFile && currentHunks.length > 0) {
        edits.push({ type: 'update', path: currentFile, hunks: currentHunks });
        currentHunks = [];
      }
      // parse target file path
      const pathPart = line.slice(4).trim();
      // remove timestamp or tab
      const cleanPath = pathPart.split('\t')[0].trim();
      let targetPath = cleanPath;
      if (cleanPath.startsWith('a/') || cleanPath.startsWith('b/')) {
        targetPath = cleanPath.slice(2);
      }
      currentFile = targetPath;
      i++;
      if (i < lines.length && lines[i].startsWith('+++ ')) {
        const plusPart = lines[i].slice(4).trim();
        const cleanPlus = plusPart.split('\t')[0].trim();
        if (!cleanPlus.startsWith('/dev/null') && cleanPlus !== '/dev/null') {
          let p2 = cleanPlus;
          if (p2.startsWith('a/') || p2.startsWith('b/')) p2 = p2.slice(2);
          if (p2 !== '' && p2 !== '/dev/null') currentFile = p2;
        }
        i++;
      }
      continue;
    }

    if (line.startsWith('@@ ')) {
      if (curHunk) {
        currentHunks.push(curHunk);
      }
      // parse hunk header @@ -l,s +l,s @@
      const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
      if (!m) {
        return { edits: [], error: { code: 'parse', line: i + 1 } };
      }
      curHunk = {
        oldStart: parseInt(m[1], 10),
        newStart: parseInt(m[2], 10),
        lines: []
      };
      i++;
      continue;
    }

    if (curHunk) {
      if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
        curHunk.lines.push({
          type: line[0],
          text: line.slice(1)
        });
        i++;
        continue;
      } else {
        // blank or invalid line in hunk
        if (line.trim() === '') {
          curHunk.lines.push({ type: ' ', text: '' });
          i++;
          continue;
        }
        // If it starts with diff headers or something else, close hunk
        currentHunks.push(curHunk);
        curHunk = null;
        continue;
      }
    }

    // If we see lines outside hunks that aren't file headers, parse error or skip
    i++;
  }

  if (curHunk) {
    currentHunks.push(curHunk);
  }
  if (currentFile && currentHunks.length > 0) {
    edits.push({ type: 'update', path: currentFile, hunks: currentHunks });
  }

  if (edits.length === 0) {
    return { edits: [], error: { code: 'parse', line: 1 } };
  }

  return { edits };
}

// --- SEARCH/REPLACE + V4A + JSON Parsers ---

function parseSearchReplace(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const edits: EditOperation[] = [];
  let i = 0;
  let lastPath: string | null = null;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('```')) {
      i++;
      continue;
    }

    if (trimmed.startsWith('<<<<<<< SEARCH')) {
      // Find path backwards
      let targetPath: string | null = lastPath;
      let scan = i - 1;
      while (scan >= 0) {
        const pLine = lines[scan].trim();
        if (pLine !== '' && !pLine.startsWith('#') && !pLine.startsWith('```')) {
          targetPath = pLine;
          break;
        }
        scan--;
      }
      if (!targetPath) {
        return { edits: [], error: { code: 'parse', line: i + 1 } };
      }
      lastPath = targetPath;
      i++;

      const searchLines: string[] = [];
      let searchStart = i + 1;
      while (i < lines.length && lines[i].trim() !== '=======') {
        searchLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) {
        return { edits: [], error: { code: 'parse', line: searchStart } };
      }
      i++; // skip =======

      const replaceLines: string[] = [];
      let replaceStart = i + 1;
      while (i < lines.length && !lines[i].trim().startsWith('>>>>>>>')) {
        replaceLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) {
        return { edits: [], error: { code: 'parse', line: replaceStart } };
      }
      const endLine = lines[i];
      const endMatch = endLine.trim().match(/^>>>>>>>(?:\s+REPLACE)?(?:\s+(.+))?$/);
      if (endMatch && endMatch[1]) {
        const p = endMatch[1].trim();
        if (p && p !== 'REPLACE') {
          targetPath = p;
          lastPath = p;
        }
      }
      i++; // skip >>>>>>>

      edits.push({
        type: 'update',
        path: targetPath,
        searchLines,
        replaceLines
      });
    } else {
      i++;
    }
  }

  if (edits.length === 0) {
    return { edits: [], error: { code: 'parse', line: 1 } };
  }

  return { edits };
}
function parseV4A(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const edits: EditOperation[] = [];

  function trimTrailingBlanks(secLines: Array<{ line: string; num: number }>) {
    const res = [...secLines];
    while (res.length > 0 && res[res.length - 1].line.trim() === "") {
      res.pop();
    }
    return res;
  }

  let firstNonBlankIdx = -1;
  let firstNonBlankText = "";
  for (let idx = 0; idx < lines.length; idx++) {
    const t = lines[idx].trim();
    if (t !== "") {
      firstNonBlankIdx = idx;
      firstNonBlankText = t;
      break;
    }
  }

  if (firstNonBlankIdx === -1 || firstNonBlankText !== "*** Begin Patch") {
    const errLine = firstNonBlankIdx === -1 ? 1 : firstNonBlankIdx + 1;
    return { edits: [], error: { code: "parse", line: errLine } };
  }

  let lastNonBlankIdx = -1;
  let lastNonBlankText = "";
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    const t = lines[idx].trim();
    if (t !== "") {
      lastNonBlankIdx = idx;
      lastNonBlankText = t;
      break;
    }
  }

  if (lastNonBlankText !== "*** End Patch") {
    const patchLineCount = text.endsWith("\n") ? lines.length - 1 : lines.length; const errLine = patchLineCount + 1;
    return { edits: [], error: { code: "parse", line: errLine } };
  }

  let i = firstNonBlankIdx + 1;
  const endIdx = lastNonBlankIdx;

  while (i < endIdx) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    if (trimmed.startsWith("*** Add File:")) {
      const path = trimmed.slice(13).trim();
      i++;
      const secLines: Array<{ line: string; num: number }> = [];
      while (i < endIdx) {
        const l = lines[i];
        const t = l.trim();
        if (t.startsWith("*** Add File:") || t.startsWith("*** Delete File:") || t.startsWith("*** Update File:")) {
          break;
        }
        secLines.push({ line: l, num: i + 1 });
        i++;
      }
      const trimmedSec = trimTrailingBlanks(secLines);
      const fileText = trimmedSec.map(item => {
        const l = item.line;
        if (l.startsWith("+")) return l.slice(1);
        return l;
      }).join("\n") + (trimmedSec.length > 0 ? "\n" : "");

      edits.push({
        type: "create",
        path,
        fileText
      });
      continue;
    }

    if (trimmed.startsWith("*** Delete File:")) {
      const path = trimmed.slice(16).trim();
      i++;
      const secLines: Array<{ line: string; num: number }> = [];
      while (i < endIdx) {
        const l = lines[i];
        const t = l.trim();
        if (t.startsWith("*** Add File:") || t.startsWith("*** Delete File:") || t.startsWith("*** Update File:")) {
          break;
        }
        secLines.push({ line: l, num: i + 1 });
        i++;
      }
      const trimmedSec = trimTrailingBlanks(secLines);
      if (trimmedSec.length > 0) {
        return { edits: [], error: { code: "parse", line: trimmedSec[0].num } };
      }
      edits.push({
        type: "delete",
        path
      });
      continue;
    }

    if (trimmed.startsWith("*** Update File:")) {
      const updateLineNum = i + 1;
      const path = trimmed.slice(16).trim();
      i++;
      const secLines: Array<{ line: string; num: number }> = [];
      while (i < endIdx) {
        const l = lines[i];
        const t = l.trim();
        if (t.startsWith("*** Add File:") || t.startsWith("*** Delete File:") || t.startsWith("*** Update File:")) {
          break;
        }
        secLines.push({ line: l, num: i + 1 });
        i++;
      }

      const trimmedSecLines = trimTrailingBlanks(secLines);

      let movePath: string | undefined = undefined;
      let chunkStartIdx = 0;

      if (trimmedSecLines.length > 0 && trimmedSecLines[0].line.trim().startsWith("*** Move to:")) {
        movePath = trimmedSecLines[0].line.trim().slice(12).trim();
        chunkStartIdx = 1;
      }

      if (chunkStartIdx >= trimmedSecLines.length && !movePath) {
        return { edits: [], error: { code: "parse", line: updateLineNum } };
      }

      const chunks: Array<{ anchor: string | null; oldLines: string[]; newLines: string[]; endOfFile: boolean; isContext: boolean[]; oIndex: number[] }> = [];
      let ci = chunkStartIdx;

      while (ci < trimmedSecLines.length) {
        let anchor: string | null = null;
        const firstItem = trimmedSecLines[ci];
        const firstTrimmed = firstItem.line.trim();

        if (firstTrimmed.startsWith("@@")) {
          anchor = firstTrimmed.slice(2).trim();
          if (anchor === "") anchor = null;
          ci++;
        }

        const oldLines: string[] = [];
        const isContext: boolean[] = [];
        const oIndex: number[] = [];
        const newLines: string[] = [];
        let endOfFile = false;
        let hasChunkContent = false;

        while (ci < trimmedSecLines.length) {
          const item = trimmedSecLines[ci];
          const l = item.line;
          const t = l.trim();

          if (t.startsWith("@@")) {
            break;
          }
          if (t === "*** End of File") {
            endOfFile = true;
            ci++;
            hasChunkContent = true;
            break;
          }

          if (l.startsWith(" ")) {
            const body = l.slice(1);
            oldLines.push(body);
            newLines.push(body);
            isContext.push(true);
            oIndex.push(oldLines.length - 1);
            hasChunkContent = true;
            ci++;
          } else if (l.startsWith("-")) {
            const body = l.slice(1);
            oldLines.push(body);
            hasChunkContent = true;
            ci++;
          } else if (l.startsWith("+")) {
            const body = l.slice(1);
            newLines.push(body);
            isContext.push(false);
            oIndex.push(-1);
            hasChunkContent = true;
            ci++;
          } else if (l === "") {
            oldLines.push("");
            newLines.push("");
            isContext.push(true);
            oIndex.push(oldLines.length - 1);
            hasChunkContent = true;
            ci++;
          } else {
            return { edits: [], error: { code: "parse", line: item.num } };
          }
        }
        
        if (!hasChunkContent) {
          return { edits: [], error: { code: "parse", line: firstItem.num } };
        }

        chunks.push({ anchor, oldLines, newLines, endOfFile, isContext, oIndex });;
      }

      edits.push({
        type: "update",
        path,
        oldPath: movePath ? path : undefined,
        newPath: movePath,
        chunks
      });
      continue;
    }

    return { edits: [], error: { code: "parse", line: i + 1 } };
  }

  if (edits.length === 0) {
    return { edits: [], error: { code: "parse", line: 1 } };
  }

  return { edits };
}
function parseJsonPatch(text: string): ParseResult {
  const trimmed = text.trim();
  const edits: EditOperation[] = [];
  if (trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      if (!Array.isArray(data)) throw new Error();
      for (const item of data) {
        if (item.command === 'create') {
          if (typeof item.path !== 'string' || typeof item.file_text !== 'string') throw new Error();
          edits.push({ type: 'create', path: item.path, fileText: item.file_text });
        } else if (item.command === 'str_replace') {
          if (typeof item.path !== 'string' || typeof item.old_str !== 'string' || item.old_str === '') throw new Error();
          edits.push({ type: 'update', path: item.path, jsonCmd: 'str_replace', oldStr: item.old_str, newStr: item.new_str ?? '' });
        } else if (item.command === 'insert') {
          if (typeof item.path !== 'string' || typeof item.insert_line !== 'number' || typeof item.new_str !== 'string') throw new Error();
          edits.push({ type: 'update', path: item.path, jsonCmd: 'insert', insertLine: item.insert_line, newStr: item.new_str });
        } else throw new Error();
      }
    } catch { return { edits: [], error: { code: 'parse', line: 1 } }; }
  } else {
    const lines = trimmed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (item.command === 'create') {
          if (typeof item.path !== 'string' || typeof item.file_text !== 'string') throw new Error();
          edits.push({ type: 'create', path: item.path, fileText: item.file_text });
        } else if (item.command === 'str_replace') {
          if (typeof item.path !== 'string' || typeof item.old_str !== 'string' || item.old_str === '') throw new Error();
          edits.push({ type: 'update', path: item.path, jsonCmd: 'str_replace', oldStr: item.old_str, newStr: item.new_str ?? '' });
        } else if (item.command === 'insert') {
          if (typeof item.path !== 'string' || typeof item.insert_line !== 'number' || typeof item.new_str !== 'string') throw new Error();
          edits.push({ type: 'update', path: item.path, jsonCmd: 'insert', insertLine: item.insert_line, newStr: item.new_str });
        } else throw new Error();
      } catch { return { edits: [], error: { code: 'parse', line: i + 1 } }; }
    }
  }
  return edits.length ? { edits } : { edits: [], error: { code: 'parse', line: 1 } };
}


function getIndent(line: string): string {
  const m = line.match(/^([ \t]*)/);
  return m ? m[1] : '';
}

function stripIndent(line: string): string {
  return line.replace(/^[ \t]*/, '');
}

function matchSearchBlock(
  fileLines: string[],
  searchLines: string[],
  hintIndex: number,
  strict: boolean
): { index: number; tier: number; count: number } {
  if (searchLines.length === 0) {
    return { index: -1, tier: -1, count: 0 };
  }

  // Tiers to try:
  // If strict is true, only tier 0. Otherwise tiers 0, 1, 2.
  const maxTier = strict ? 0 : 2;

  for (let tier = 0; tier <= maxTier; tier++) {
    const matches: number[] = [];

    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
      let matched = true;
      let indentDiff = 0;

      if (tier === 0) {
        // Exact match
        for (let j = 0; j < searchLines.length; j++) {
          if (fileLines[i + j] !== searchLines[j]) {
            matched = false;
            break;
          }
        }
      } else if (tier === 1) {
        // Trailing-whitespace-insensitive
        for (let j = 0; j < searchLines.length; j++) {
          if (fileLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
            matched = false;
            break;
          }
        }
      } else if (tier === 2) {
        // Indent-insensitive
        // Check if all non-empty lines have proportional or matching relative indentation, or stripped content matches
        const fileFirst = fileLines[i];
        const searchFirst = searchLines[0];
        const fileIndent = getIndent(fileFirst);
        const searchIndent = getIndent(searchFirst);
        // Calculate indent difference if both have indentation
        indentDiff = fileIndent.length - searchIndent.
          length; // Or check line-by-line relative match

        for (let j = 0; j < searchLines.length; j++) {
          const fLine = fileLines[i + j];
          const sLine = searchLines[j];
          if (fLine.trim() === '' && sLine.trim() === '') {
            continue;
          }
          if (stripIndent(fLine) !== stripIndent(sLine)) {
            matched = false;
            break;
          }
        }
      }

      if (matched) {
        matches.push(i);
      }
    }

    if (matches.length > 0) {
      if (matches.length === 1) {
        return { index: matches[0], tier, count: 1 };
      }
      // If multiple matches, use hintIndex if valid, otherwise ambiguous (count > 1)
      if (hintIndex >= 0 && matches.includes(hintIndex)) {
        return { index: hintIndex, tier, count: matches.length };
      }
      // Pick closest to hintIndex if hintIndex >= 0
      if (hintIndex >= 0) {
        let best = matches[0];
        let bestDist = Math.abs(best - hintIndex);
        for (let m = 1; m < matches.length; m++) {
          const dist = Math.abs(matches[m] - hintIndex);
          if (dist < bestDist) {
            bestDist = dist;
            best = matches[m];
          }
        }
        return { index: best, tier, count: matches.length };
      }
      return { index: matches[0], tier, count: matches.length };
    }
  }

  return { index: -1, tier: -1, count: 0 };
}

// --- Apply Logic & Execution ---

function applyUnifiedHunks(
  fileLines: { lines: string[]; hasEndingNewline: boolean },
  hunks: Array<{ oldStart: number; newStart: number; lines: Array<{ type: ' ' | '-' | '+'; text: string }>; noNewlineAtEndOfFile?: boolean }>
, strict: boolean): { success: boolean; lines?: string[]; error?: { code: string } } {
  let lines = [...fileLines.lines];
  let d = 0;

  for (const hunk of hunks) {
    const O: { text: string; type: ' ' | '-' }[] = [];
    const N: { text: string; type: ' ' | '+' }[] = [];
    
    // Build O (context + -) and N (context + +)
    for (const hl of hunk.lines) {
      if (hl.type === ' ' || hl.type === '-') {
        O.push({ text: hl.text, type: hl.type });
      }
      if (hl.type === ' ' || hl.type === '+') {
        N.push({ text: hl.text, type: hl.type });
      }
    }

    const A = hunk.oldStart;
    let matchIndex = -1;
    let tier = 1;

    if (O.length === 0) {
      matchIndex = Math.min(A + d, lines.length);
    } else {
      const searchLines = O.map(o => o.text);
      const hint = A - 1 + d;
      const match = matchSearchBlock(lines, searchLines, hint, strict);
      matchIndex = match.index;
      tier = match.tier;
    }

    if (matchIndex === -1) {
      return { success: false, error: { code: 'no-match' } };
    }

    // Build finalN
    const finalN: string[] = [];
    if (O.length > 0) {
      for (let i = 0; i < N.length; i++) {
        if (N[i].type === ' ') {
          // Context line from file
          finalN.push(lines[matchIndex + i]);
        } else {
          // Non-context line (new or replaced)
          let text = N[i].text;
          if (tier === 2) {
            const P = O[0].text.match(/^([ 	]*)/)?.[1] || '';
            const F = lines[matchIndex].match(/^([ 	]*)/)?.[1] || '';
            if (text.length > 0 && text.trim() !== '' && text.startsWith(P)) {
              text = F + text.slice(P.length);
            }
          }
          finalN.push(text);
        }
      }
    } else {
      for (const nl of N) {
        finalN.push(nl.text);
      }
    }

    // Splice
    const removeCount = O.length > 0 ? O.length : 0;
    lines.splice(matchIndex, removeCount, ...finalN);
    
    // Update d: sum of (N.length - O.length)
    d += (N.length - O.length);
  }

  return { success: true, lines };
}
function applyV4AUpdate(fileLines: FileLines, chunks: Array<{ anchor: string | null; oldLines: string[]; newLines: string[]; endOfFile: boolean; isContext: boolean[]; oIndex: number[] }>, strict: boolean): { success: boolean; lines?: string[]; error?: { code: string } } {
  let lines = [...fileLines.lines];
  let cursor = 0;

  for (const chunk of chunks) {
    let matchIdx = -1;
    let matchTier = 0;

    if (chunk.anchor !== null) {
      let foundAnchor = -1;
      for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
        let bestIdx = -1;
        for (let idx = cursor; idx <= lines.length - 1; idx++) {
          let matched = false;
          if (tier === 0) {
            matched = (lines[idx] === chunk.anchor);
          } else if (tier === 1) {
            matched = (lines[idx].trimEnd() === chunk.anchor.trimEnd());
          } else if (tier === 2) {
            matched = (lines[idx].trim() === chunk.anchor.trim());
          }
          if (matched) {
            bestIdx = idx;
            matchTier = tier;
            break;
          }
        }
        if (bestIdx !== -1) {
          foundAnchor = bestIdx;
          break;
        }
      }
      if (foundAnchor === -1) {
        return { success: false, error: { code: "no-match" } };
      }
      matchIdx = foundAnchor;
      cursor = matchIdx + 1;
    }

    const O = chunk.oldLines;
    const N = chunk.newLines;

    if (O.length === 0) {
      let insPos = cursor;
      if (chunk.endOfFile) {
        insPos = lines.length;
      }
      lines.splice(insPos, 0, ...N);
      cursor = insPos + N.length;
      continue;
    }

    let targetIdx = -1;
    let targetTier = 0;

    const maxTier = strict ? 0 : 2;
    for (let tier = 0; tier <= maxTier; tier++) {
      let found = -1;
      for (let idx = cursor; idx <= lines.length - O.length; idx++) {
        if (chunk.endOfFile && (idx + O.length !== lines.length)) {
          continue;
        }
        let matched = true;
        for (let j = 0; j < O.length; j++) {
          const fLine = lines[idx + j];
          const oLine = O[j];
          if (tier === 0) {
            if (fLine !== oLine) { matched = false; break; }
          } else if (tier === 1) {
            if (fLine.trimEnd() !== oLine.trimEnd()) { matched = false; break; }
          } else if (tier === 2) {
            if (fLine.trim() === "" && oLine.trim() === "") continue;
            if (stripIndent(fLine) !== stripIndent(oLine)) { matched = false; break; }
          }
        }
        if (matched) {
          found = idx;
          targetTier = tier;
          break;
        }
      }
      if (found !== -1) {
        targetIdx = found;
        break;
      }
    }

    if (targetIdx === -1) {
      return { success: false, error: { code: "no-match" } };
    }

    let finalN = [];
    const fileIndent = targetTier === 2 ? getIndent(lines[targetIdx]) : "";
    const searchIndent = targetTier === 2 ? getIndent(O[0]) : "";
    
    for (let i = 0; i < N.length; i++) {
        if (chunk.isContext[i]) {
            finalN.push(lines[targetIdx + chunk.oIndex[i]]);
        } else {
            let line = N[i];
            if (targetTier === 2 && line.trim() !== "" && searchIndent !== "" && line.startsWith(searchIndent)) {
                line = fileIndent + line.slice(searchIndent.length);
            }
            finalN.push(line);
        }
    }

    lines.splice(targetIdx, O.length, ...finalN);
    cursor = targetIdx + finalN.length;
  }

  return { success: true, lines };
}

function applySearchReplaceEdit(fileLines: FileLines, searchLines: string[], replaceLines: string[], strict: boolean): { success: boolean; lines?: string[]; error?: { code: string } } {
  const match = matchSearchBlock(fileLines.lines, searchLines, -1, strict);
  if (match.index === -1) {
    return { success: false, error: { code: 'no-match' } };
  }
  if (match.count > 1) {
    return { success: false, error: { code: 'ambiguous' } };
  }

  let finalReplace = replaceLines;
  if (match.tier === 2 && searchLines.length > 0) {
    const fileIndent = getIndent(fileLines.lines[match.index]);
    const searchIndent = getIndent(searchLines[0]);
    if (fileIndent !== searchIndent) {
      finalReplace = replaceLines.map((rLine) => {
        if (rLine.trim() === '') return rLine;
        const stripped = stripIndent(rLine);
        return fileIndent + stripped;
      });
    }
  }

  const newLines = [...fileLines.lines];
  newLines.splice(match.index, searchLines.length, ...finalReplace);
  return { success: true, lines: newLines };
}

// --- Main Flow & Invocation ---

function main() {
  const cliArgs = process.argv.slice(2);
  const parsedCli = parseCliArgs(cliArgs);
  if (parsedCli.error || !parsedCli.args) {
    process.stdout.write('error: usage\n');
    process.exit(2);
  }

  const { format: explicitFormat, check, strict, patchPath } = parsedCli.args;

  // Read patch from stdin or file
  let patchText = '';
  try {
    if (patchPath === null || patchPath === '-') {
      patchText = fs.readFileSync(0, 'utf8');
    } else {
      if (!fs.existsSync(patchPath)) {
        process.stdout.write('error: no-patch\n');
        process.exit(2);
      }
      patchText = fs.readFileSync(patchPath, 'utf8');
    }
  } catch (err) {
    process.stdout.write('error: no-patch\n');
    process.exit(2);
  }

  // Detect format if not specified
  let format = explicitFormat;
  if (!format) {
    const detected = detectFormat(patchText);
    if (!detected) {
      process.stdout.write('error: format\n');
      process.exit(2);
    }
    format = detected;
  }

  // Parse patch
  let parseResult: ParseResult;
  if (format === 'unified') {
    parseResult = parseUnifiedDiff(patchText);
  } else if (format === 'search-replace') {
    parseResult = parseSearchReplace(patchText);
  } else if (format === 'v4a') {
    parseResult = parseV4A(patchText);
  } else if (format === 'json') {
    parseResult = parseJsonPatch(patchText);
  } else {
    process.stdout.write('error: format\n');
    process.exit(2);
  }

  if (parseResult.error) {
    process.stdout.write(`error: parse ${parseResult.error.line}\n`);
    process.exit(2);
  }

  const edits = parseResult.edits;
  if (edits.length === 0) {
    process.stdout.write('error: parse 1\n');
    process.exit(2);
  }

  // Validate paths safety before doing anything
  for (const edit of edits) {
    const p = edit.path;
    if (!isSafePath(p)) {
      process.stdout.write(`error: unsafe ${p}\n`);
      process.exit(1);
    }
    if (edit.oldPath && !isSafePath(edit.oldPath)) {
      process.stdout.write(`error: unsafe ${edit.oldPath}\n`);
      process.exit(1);
    }
    if (edit.newPath && !isSafePath(edit.newPath)) {
      process.stdout.write(`error: unsafe ${edit.newPath}\n`);
      process.exit(1);
    }
  }

  // Simulate or prepare file states
  // We need virtual file system state or working on actual files.
  // Since mend operates on the working directory, let's load files as needed or simulate.
  // But wait! If an edit fails halfway, atomicity requires ALL edits to succeed or nothing changes.
  // So we run a dry-run validation of all edits first.

  const fileStates = new Map<string, { exists: boolean; content?: string; lines?: FileLines }>();

  function getFileState(p: string) {
    if (fileStates.has(p)) return fileStates.get(p)!;
    const exists = fs.existsSync(p);
    let content: string | undefined;
    let lines: FileLines | undefined;
    if (exists) {
      content = fs.readFileSync(p, 'utf8');
      lines = parseFileContent(content);
    }
    const state = { exists, content, lines };
    fileStates.set(p, state);
    return state;
  }

  const plannedChanges: Array<{
    type: 'M' | 'A' | 'D' | 'R';
    path: string;
    oldPath?: string;
    newPath?: string;
    newContent?: string;
  }> = [];

  const errorLines: string[] = [];

  // Track virtual file modifications during dry run / staging
  const virtualFiles = new Map<string, { exists: boolean; lines?: FileLines; raw?: string }>();

  function getVirtualFile(p: string) {
    if (virtualFiles.has(p)) return virtualFiles.get(p)!;
    const st = getFileState(p);
    const v = { exists: st.exists, lines: st.lines ? { lines: [...st.lines.lines], crlf: st.lines.crlf, hasEndingNewline: st.lines.hasEndingNewline } : undefined, raw: st.content };
    virtualFiles.set(p, v);
    return v;
  }

  for (const edit of edits) {
    if (edit.type === 'create') {
      const v = getVirtualFile(edit.path);
      if (v.exists) {
        errorLines.push(`error: exists ${edit.path}`);
        continue;
      }
      virtualFiles.set(edit.path, { exists: true, raw: edit.fileText ?? '' });
      plannedChanges.push({ type: 'A', path: edit.path });
    } else if (edit.type === 'delete') {
      const v = getVirtualFile(edit.path);
      if (!v.exists) {
        errorLines.push(`error: missing ${edit.path}`);
        continue;
      }
      virtualFiles.set(edit.path, { exists: false });
      plannedChanges.push({ type: 'D', path: edit.path });
    } else if (edit.type === 'move') {
      const oldP = edit.oldPath!;
      const newP = edit.newPath!;
      const vOld = getVirtualFile(oldP);
      const vNew = getVirtualFile(newP);
      if (!vOld.exists) {
        errorLines.push(`error: missing ${oldP}`);
        continue;
      }
      if (vNew.exists) {
        errorLines.push(`error: exists ${newP}`);
        continue;
      }
      virtualFiles.set(oldP, { exists: false });
      virtualFiles.set(newP, vOld);
      plannedChanges.push({ type: 'R', path: newP, oldPath: oldP, newPath: newP });
    } else {
      // update
      const v = getVirtualFile(edit.path);
      if (!v.exists) {
        errorLines.push(`error: missing ${edit.path}`);
        continue;
      }
      if (edit.jsonCmd === 'str_replace') {
        const isCrlf = v.raw?.includes('\r\n') ?? false;
        let text = v.raw?.replace(/\r\n/g, '\n') ?? '';
        const oldStr = edit.oldStr?.replace(/\r\n/g, '\n') ?? '';
        const newStr = edit.newStr?.replace(/\r\n/g, '\n') ?? '';
        let count = 0, pos = -1;
        while ((pos = text.indexOf(oldStr, pos + 1)) !== -1) count++;
        if (count === 0) { errorLines.push(`error: no-match ${edit.path}`); continue; }
        if (count > 1) { errorLines.push(`error: ambiguous ${edit.path}`); continue; }
        text = text.replace(oldStr, newStr);
        if (isCrlf) text = text.replace(/\n/g, '\r\n');
        v.raw = text;
        v.lines = undefined;
        plannedChanges.push({ type: 'M', path: edit.path });
      } else if (edit.jsonCmd === 'insert') {
        if (!v.lines) v.lines = parseFileContent(v.raw ?? '');
        const lines = v.lines.lines;
        if (edit.insertLine! < 0 || edit.insertLine! > lines.length) { errorLines.push(`error: no-match ${edit.path}`); continue; }
        const newLines = edit.newStr!.split('\n').map(l => l.replace(/\r$/, ''));
        if (newLines.length > 0 && (edit.newStr === '' || edit.newStr.endsWith('\n'))) newLines.pop();
        lines.splice(edit.insertLine!, 0, ...newLines);
        v.lines.lines = lines;
        v.raw = undefined;
        plannedChanges.push({ type: 'M', path: edit.path });
      } else if (edit.hunks) {
        // unified
        if (!v.lines && v.raw !== undefined) {
          v.lines = parseFileContent(v.raw);
        }
        const res = applyUnifiedHunks(v.lines || { lines: [], crlf: false, hasEndingNewline: false }, edit.hunks, strict);
        if (!res.success) {
          errorLines.push(`error: ${res.error?.code || 'no-match'} ${edit.path}`);
          continue;
        }
        v.lines = {
          lines: res.lines!,
          crlf: v.lines?.crlf ?? false,
          hasEndingNewline: v.lines?.hasEndingNewline ?? true
        };
        plannedChanges.push({ type: 'M', path: edit.path });
      } else if (edit.chunks) {
        // v4a
        if (edit.newPath && getVirtualFile(edit.newPath).exists) {
          errorLines.push(`error: exists ${edit.newPath}`);
          continue;
        }
        if (!v.lines && v.raw !== undefined) {
          v.lines = parseFileContent(v.raw);
        }
        const res = applyV4AUpdate(v.lines || { lines: [], crlf: false, hasEndingNewline: false }, edit.chunks, strict);
        if (!res.success) {
          errorLines.push(`error: ${res.error?.code || "no-match"} ${edit.path}`);
          continue;
        }
        v.lines = {
          lines: res.lines!,
          crlf: v.lines?.crlf ?? false,
          hasEndingNewline: v.lines?.hasEndingNewline ?? true
        };
        if (edit.newPath) {
          virtualFiles.set(edit.path, { exists: false });
          virtualFiles.set(edit.newPath, v);
          plannedChanges.push({ type: "R", path: edit.newPath, oldPath: edit.path, newPath: edit.newPath });
        } else {
          plannedChanges.push({ type: "M", path: edit.path });
        }
      } else {
        // search-replace
        if (!v.lines && v.raw !== undefined) {
          v.lines = parseFileContent(v.raw);
        }
        const res = applySearchReplaceEdit(v.lines || { lines: [], crlf: false, hasEndingNewline: false }, edit.searchLines || [], edit.replaceLines || [], strict);
        if (!res.success) {
          errorLines.push(`error: ${res.error?.code || 'no-match'} ${edit.path}`);
          continue;
        }
        v.lines = {
          lines: res.lines!,
          crlf: v.lines?.crlf ?? false,
          hasEndingNewline: v.lines?.hasEndingNewline ?? true
        };
        plannedChanges.push({ type: 'M', path: edit.path });
      }
    }
  }

  if (errorLines.length > 0) {
    for (const errLine of errorLines) {
      process.stdout.write(errLine + '\n');
    }
    process.stdout.write(`failed: ${errorLines.length} of ${edits.length} edits\n`);
    process.exit(1);
  }

  // If --check, do not write anything, but output success summary as if written
  // Wait, does --check output ok: N files?
  // SPEC 1: "--check does everything but write: the same output and exit code as without it, and no file is created, changed or deleted."
  // So yes, exit 0 and print the changes and ok: N files.

  // Deduplicate / consolidate planned changes and check if content actually changed
  const finalChanges: Array<{ type: string; lineStr: string; sortKey: string }> = [];

  // Group by path to determine final state vs original state
  const touchedPaths = new Set<string>();
  for (const c of plannedChanges) {
    if (c.oldPath) touchedPaths.add(c.oldPath);
    touchedPaths.add(c.path);
  }

  // Check rename optimization: if oldPath deleted and newPath created with same content or move op
  const moves = plannedChanges.filter(c => c.type === 'R');
  const nonMoveChanges = plannedChanges.filter(c => c.type !== 'R');

  // Let's build map of path -> final content vs original content
  const pathSummary = new Map<string, string>(); // path -> action type (A, D, M, R)

  // Actually, let's compare virtualFiles final vs original fileStates
  const allPaths = new Set<string>();
  for (const p of fileStates.keys()) allPaths.add(p);
  for (const p of virtualFiles.keys()) allPaths.add(p);

  const outputLines: Array<{ sortKey: string; line: string }> = [];

  // Handle moves explicitly
  const handledPaths = new Set<string>();
  for (const m of moves) {
    const oldP = m.oldPath!;
    const newP = m.newPath!;
    handledPaths.add(oldP);
    handledPaths.add(newP);
    outputLines.push({ sortKey: newP, line: `R ${oldP} -> ${newP}` });
  }

  for (const [p, v] of virtualFiles.entries()) {
    if (handledPaths.has(p)) continue;
    const orig = fileStates.get(p);
    const origExists = orig ? orig.exists : false;
    const origContent = orig ? (orig.content ?? '') : '';

    let newContent = '';
    if (v.exists) {
      if (v.raw !== undefined && !v.lines) {
        newContent = v.raw;
      } else if (v.lines) {
        newContent = serializeFileContent(v.lines);
      }
    }

    if (!origExists && v.exists) {
      outputLines.push({ sortKey: p, line: `A ${p}` });
    } else if (origExists && !v.exists) {
      outputLines.push({ sortKey: p, line: `D ${p}` });
    } else if (origExists && v.exists) {
      if (origContent !== newContent) {
        outputLines.push({ sortKey: p, line: `M ${p}` });
      }
    }
  }

  // Sort output lines by path (UTF-8 byte order of paths)
  outputLines.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  if (!check) {
    // Perform actual disk writes
    for (const [p, v] of virtualFiles.entries()) {
      const orig = fileStates.get(p);
      const origExists = orig ? orig.exists : false;
      const origContent = orig ? (orig.content ?? '') : '';

      let newContent = '';
      if (v.exists) {
        if (v.raw !== undefined && !v.lines) {
          newContent = v.raw;
        } else if (v.lines) {
          newContent = serializeFileContent(v.lines);
        }
      }

      if (!v.exists) {
        if (origExists && fs.existsSync(p)) {
          fs.unlinkSync(p);
        }
      } else {
        // Ensure parent directories exist
        const dir = path.dirname(p);
        if (dir && dir !== '.' && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(p, newContent, 'utf8');
      }
    }

    // Handle delete for old paths in moves if any
    for (const m of moves) {
      if (fs.existsSync(m.oldPath!)) {
        fs.unlinkSync(m.oldPath!);
      }
    }
  }

  for (const ol of outputLines) {
    process.stdout.write(ol.line + '\n');
  }

  const nFiles = outputLines.length;
  if (nFiles === 1) {
    process.stdout.write('ok: 1 file\n');
  } else {
    process.stdout.write(`ok: ${nFiles} files\n`);
  }
  process.exit(0);
}

main();
