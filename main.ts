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
  fileText?: string; // for create / json
  hunks?: any[]; // for unified
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
    if (line.startsWith('=== file:') || line.startsWith('=== create:') || line.startsWith('=== delete:') || line.startsWith('=== move:')) {
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

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) {
      i++;
      continue;
    }

    // Check for file header: <<<<<<< file: path or similar or just <<<<<<< SEARCH
    let targetPath: string | null = null;
    if (line.startsWith('<<<<<<< file:')) {
      targetPath = line.slice(13).trim();
      i++;
    } else if (line.startsWith('<<<<<<< SEARCH')) {
      i++;
    } else {
      // Maybe look for file: path header preceding SEARCH
      if (line.startsWith('=== file:') || line.startsWith('file:')) {
        targetPath = line.split(':')[1].trim();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // If targetPath not set yet, check if next lines specify it or if there's an explicit file header above
    // In search-replace, often format is:
    // path/to/file
    // <<<<<<< SEARCH
    // ...
    // =======
    // ...
    // >>>>>>> REPLACE
    
    // Let's parse SEARCH lines
    const searchLines: string[] = [];
    let searchStartLine = i + 1;
    while (i < lines.length && !lines[i].startsWith('=======')) {
      searchLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      return { edits: [], error: { code: 'parse', line: searchStartLine } };
    }
    i++; // skip =======

    const replaceLines: string[] = [];
    let replaceStartLine = i + 1;
    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
      replaceLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      return { edits: [], error: { code: 'parse', line: replaceStartLine } };
    }
    const endLine = lines[i];
    // >>>>>>> REPLACE [path] or >>>>>>> [path]
    const endMatch = endLine.match(/^>>>>>>>(?:\s+REPLACE)?(?:\s+(.+))?$/);
    if (endMatch && endMatch[1]) {
      const p = endMatch[1].trim();
      if (p && p !== 'REPLACE') targetPath = p;
    }
    i++; // skip >>>>>>>

    if (!targetPath) {
      // look backwards or default? In standard search-replace, targetPath must be known or specified in header/footer
      return { edits: [], error: { code: 'parse', line: searchStartLine } };
    }

    edits.push({
      type: 'update',
      path: targetPath,
      searchLines,
      replaceLines
    });
  }

  if (edits.length === 0) {
    return { edits: [], error: { code: 'parse', line: 1 } };
  }

  return { edits };
}

function parseV4A(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const edits: EditOperation[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) {
      i++;
      continue;
    }

    if (line.startsWith('=== file:')) {
      const filePath = line.slice(9).trim();
      i++;
      // read SEARCH/REPLACE or text block until next === or EOF
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      let mode: 'search' | 'replace' = 'search';

      while (i < lines.length && !lines[i].startsWith('===')) {
        const l = lines[i];
        if (l.startsWith('<<<<<<< SEARCH') || l.startsWith('<<<<<<<')) {
          mode = 'search';
          i++;
          continue;
        }
        if (l.startsWith('=======')) {
          mode = 'replace';
          i++;
          continue;
        }
        if (l.startsWith('>>>>>>>')) {
          i++;
          continue;
        }
        if (mode === 'search') searchLines.push(l);
        else replaceLines.push(l);
        i++;
      }
      edits.push({
        type: 'update',
        path: filePath,
        searchLines,
        replaceLines
      });
      continue;
    }

    if (line.startsWith('=== create:')) {
      const filePath = line.slice(11).trim();
      i++;
      const fileLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('===')) {
        fileLines.push(lines[i]);
        i++;
      }
      edits.push({
        type: 'create',
        path: filePath,
        fileText: fileLines.join('\n') + (fileLines.length > 0 ? '\n' : '')
      });
      continue;
    }

    if (line.startsWith('=== delete:')) {
      const filePath = line.slice(11).trim();
      edits.push({
        type: 'delete',
        path: filePath
      });
      i++;
      continue;
    }

    if (line.startsWith('=== move:')) {
      const parts = line.slice(9).trim().split('->');
      if (parts.length === 2) {
        edits.push({
          type: 'move',
          path: parts[1].trim(),
          oldPath: parts[0].trim(),
          newPath: parts[1].trim()
        });
      }
      i++;
      continue;
    }

    i++;
  }

  if (edits.length === 0) {
    return { edits: [], error: { code: 'parse', line: 1 } };
  }

  return { edits };
}

function parseJsonPatch(text: string): ParseResult {
  try {
    const data = JSON.parse(text);
    const rawEdits = Array.isArray(data) ? data : (data.edits || data.operations || [data]);
    const edits: EditOperation[] = [];

    for (const item of rawEdits) {
      const type = item.type || item.op || 'update';
      const p = item.path || item.file || item.target;
      if (!p) {
        return { edits: [], error: { code: 'parse', line: 1 } };
      }

      if (type === 'create') {
        edits.push({
          type: 'create',
          path: p,
          fileText: item.file_text ?? item.content ?? item.text ?? ''
        });
      } else if (type === 'delete') {
        edits.push({
          type: 'delete',
          path: p
        });
      } else if (type === 'move' || type === 'rename') {
        const oldP = item.old_path || item.old || item.from;
        const newP = item.new_path || item.new || item.to || p;
        edits.push({
          type: 'move',
          path: newP,
          oldPath: oldP,
          newPath: newP
        });
      } else {
        // update
        const searchLines = item.search_lines || item.search || (item.old_text ? item.old_text.split('\n') : undefined);
        const replaceLines = item.replace_lines || item.replace || (item.new_text ? item.new_text.split('\n') : undefined);
        edits.push({
          type: 'update',
          path: p,
          searchLines: Array.isArray(searchLines) ? searchLines : (searchLines ? searchLines.split('\n') : []),
          replaceLines: Array.isArray(replaceLines) ? replaceLines : (replaceLines ? replaceLines.split('\n') : [])
        });
      }
    }

    if (edits.length === 0) {
      return { edits: [], error: { code: 'parse', line: 1 } };
    }

    return { edits };
  } catch (err: any) {
    return { edits: [], error: { code: 'parse', line: 1 } };
  }
}

// --- Matching Engine ---

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

function applyUnifiedHunks(fileLines: FileLines, hunks: any[], strict: boolean): { success: boolean; lines?: string[]; error?: { code: string } } {
  let lines = [...fileLines.lines];
  // Process hunks from bottom to top so line numbers remain stable
  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sortedHunks) {
    const searchLines: string[] = [];
    const replaceLines: string[] = [];
    for (const hl of hunk.lines) {
      if (hl.type === ' ' || hl.type === '-') {
        searchLines.push(hl.text);
      }
      if (hl.type === ' ' || hl.type === '+') {
        replaceLines.push(hl.text);
      }
    }

    const hint = hunk.oldStart - 1;
    const match = matchSearchBlock(lines, searchLines, hint, strict);
    if (match.index === -1) {
      return { success: false, error: { code: 'no-match' } };
    }
    if (match.count > 1) {
      // Check if hint distinguishes or if it's ambiguous
      // In unified diffs, if multiple matches, check if hint matches exact oldStart
      if (hint >= 0 && hint < lines.length) {
        // verify exact match at hint
        let exactAtHint = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (lines[hint + j] !== searchLines[j]) {
            exactAtHint = false;
            break;
          }
        }
        if (!exactAtHint) {
          return { success: false, error: { code: 'ambiguous' } };
        }
        lines.splice(hint, searchLines.length, ...replaceLines);
        continue;
      }
      return { success: false, error: { code: 'ambiguous' } };
    }

    // Apply replacement at match.index
    // If tier 2 (indent-insensitive), re-indent replaceLines relative to file indentation
    let finalReplace = replaceLines;
    if (match.tier === 2 && searchLines.length > 0) {
      const fileIndent = getIndent(lines[match.index]);
      const searchIndent = getIndent(searchLines[0]);
      if (fileIndent !== searchIndent) {
        finalReplace = replaceLines.map((rLine) => {
          if (rLine.trim() === '') return rLine;
          const rIndent = getIndent(rLine);
          // adjust rLine indentation
          const stripped = stripIndent(rLine);
          return fileIndent + stripped;
        });
      }
    }

    lines.splice(match.index, searchLines.length, ...finalReplace);
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
