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
