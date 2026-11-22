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
