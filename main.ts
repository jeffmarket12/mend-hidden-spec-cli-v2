import * as fs from 'fs';
import * as path from 'path';

function isSafePath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (p.startsWith('/') || p.includes('\\')) return false;
  const segments = p.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return false;
  }
  return true;
}

interface FileContent {
  text: string;
  crlf: boolean;
  hasEol: boolean;
  lines: string[];
}

function parseFile(content: string): FileContent {
  const firstLf = content.indexOf('\n');
  const isCrlf = firstLf !== -1 && firstLf > 0 && content[firstLf - 1] === '\r';
  const hasEol = content.length > 0 && (isCrlf ? content.endsWith('\r\n') : content.endsWith('\n'));
  const normalized = isCrlf ? content.replace(/\r\n/g, '\n') : content;
  let rawLines = normalized.split('\n');
  let finalHasEol = false;
  if (content.length > 0) {
    if (content.endsWith(isCrlf ? '\r\n' : '\n')) {
      finalHasEol = true;
      rawLines.pop();
    }
  } else {
    rawLines = [];
  }
  return { text: content, crlf: isCrlf, hasEol: finalHasEol, lines: rawLines };
}

function serializeFile(fc: FileContent): string {
  const eol = fc.crlf ? '\r\n' : '\n';
  if (fc.lines.length === 0 && !fc.hasEol) return '';
  let res = fc.lines.join(eol);
  if (fc.hasEol) res += eol;
  return res;
}

function locateGrade0(docRows: string[], oLines: string[]): number[] {
  const matches: number[] = [];
  if (oLines.length === 0 || oLines.length > docRows.length) return matches;
  for (let i = 0; i <= docRows.length - oLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oLines.length; j++) {
      if (docRows[i + j] !== oLines[j]) { ok = false; break; }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

function cleanTier1(s: string): string { return s.replace(/[ \t]+$/, ''); }
function locateGrade1(docRows: string[], oLines: string[]): number[] {
  const matches: number[] = [];
  if (oLines.length === 0 || oLines.length > docRows.length) return matches;
  const cleanedFile = docRows.map(cleanTier1);
  const cleanedO = oLines.map(cleanTier1);
  for (let i = 0; i <= docRows.length - oLines.length; i++) {
    let ok = true;
    for (let j = 0; j < cleanedO.length; j++) {
      if (cleanedFile[i + j] !== cleanedO[j]) { ok = false; break; }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

function cleanTier2(s: string): string { return s.replace(/^[ \t]+|[ \t]+$/g, ''); }
function locateGrade2(docRows: string[], oLines: string[]): number[] {
  const matches: number[] = [];
  if (oLines.length === 0 || oLines.length > docRows.length) return matches;
  const cleanedFile = docRows.map(cleanTier2);
  const cleanedO = oLines.map(cleanTier2);
  for (let i = 0; i <= docRows.length - oLines.length; i++) {
    let ok = true;
    for (let j = 0; j < cleanedO.length; j++) {
      if (cleanedFile[i + j] !== cleanedO[j]) { ok = false; break; }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

function locateInstance(docRows: string[], oLines: string[], rigid: boolean): { index: number; tier: number } | null {
  if (oLines.length === 0) return null;
  const t0 = locateGrade0(docRows, oLines);
  if (t0.length > 0) return { index: t0[0], tier: 0 };
  if (rigid) return null;
  const t1 = locateGrade1(docRows, oLines);
  if (t1.length > 0) return { index: t1[0], tier: 1 };
  const t2 = locateGrade2(docRows, oLines);
  if (t2.length > 0) return { index: t2[0], tier: 2 };
  return null;
}

function extractLeadingIndent(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}

// Align old (o) and new (n) lines via LCS under the tier's equality, then build
// the replacement: every CONTEXT line (present in both o and n) is emitted as
// the FILE's own matched line, never the patch's (SPEC) — this drops the
// patch's trailing whitespace / indentation from context lines. Lines only in
// n are additions and are emitted as the patch wrote them (with the tier-2
// indent transform applied). docRows[i] is the file's line matching o[i].
function reconcileReplace(oLines: string[], nLines: string[], docRows: string[], tier: number): string[] {
  const eq = (a: string, b: string) => tier === 0 ? a === b : tier === 1 ? a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '') : a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');
  const m = oLines.length, n = nLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i][j] = eq(oLines[i], nLines[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const fIndent = tier >= 2 && docRows.length > 0 ? extractLeadingIndent(docRows[0]) : '';
  const pIndent = tier >= 2 && oLines.length > 0 ? extractLeadingIndent(oLines[0]) : '';
  const shiftIndent = (line: string) => {
    if (tier < 2) return line;
    if (line === '' || line.trim() === '') return line;
    // SPEC section 5: a non-context line of N starting with P (O's first
    // line's leading whitespace) has P replaced by F (the file's first
    // matched line's leading whitespace). When P is empty, every line
    // "starts with P", so F is prepended.
    return line.startsWith(pIndent) ? fIndent + line.slice(pIndent.length) : line;
  };
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(oLines[i], nLines[j])) { out.push(docRows[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }
    else { out.push(shiftIndent(nLines[j])); j++; }
  }
  while (j < n) { out.push(shiftIndent(nLines[j])); j++; }
  return out;
}

interface EditOp {
  type: 'create' | 'delete' | 'update' | 'rename';
  path: string;
  newPath?: string;
  hunks?: { o: string[]; n: string[]; hasEol: boolean; a?: number; body?: { type: string; text: string }[] }[];
  content?: string[];
  chunks?: { anchor?: string; o: string[]; n: string[]; isEof?: boolean; body?: { type: string; text: string }[] }[];
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function detectFormat(patchText: string): string {
  const lines = patchText.split('\n').map(l => l.replace(/\r$/, ''));
  let firstNonBlank = '';
  for (const l of lines) { if (l.trim() !== '') { firstNonBlank = l.trim(); break; } }
  if (firstNonBlank === '*** Begin Patch') return 'v4a';
  if (firstNonBlank.startsWith('[') || firstNonBlank.startsWith('{')) return 'json';
  for (const l of lines) { if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace'; }
  for (const l of lines) { if (l.startsWith('diff --git ')) return 'unified'; }
  for (let i = 0; i < lines.length - 1; i++) { if (lines[i].startsWith('--- ') && lines[i+1].startsWith('+++ ')) return 'unified'; }
  return 'unknown';
}

function parseUnified(patchText: string): { ops: EditOp[]; error?: { line: number } } {
  const lines = patchText.split('\n').map(l => l.replace(/\r$/, ''));
  const ops: EditOp[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let isDiffGit = line.startsWith('diff --git ');
    let isHeaderPair = line.startsWith('--- ') && i + 1 < lines.length && lines[i+1].startsWith('+++ ');
    if (!isDiffGit && !isHeaderPair) { i++; continue; }
    
    let oldPath = '', newPath = '', isCreation = false, isDeletion = false;
    if (isDiffGit) {
      const parts = line.slice(11).trim().split(/\s+/);
      if (parts.length >= 2) { oldPath = parts[0]; newPath = parts[1]; }
      i++;
    } else {
      // Bare ---/+++ header pair (no diff --git line): parse the paths here.
      oldPath = line.slice(4).trim().split('\t')[0];
      newPath = lines[i + 1].slice(4).trim().split('\t')[0];
      i += 2;
    }
    
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.startsWith('@@ ') || cur.startsWith('diff --git ')) break;
      if (cur.startsWith('--- ')) {
        if (i + 1 >= lines.length || !lines[i+1].startsWith('+++ ')) return { ops: [], error: { line: i + 2 } };
        oldPath = cur.slice(4).trim().split('\t')[0];
        newPath = lines[i+1].slice(4).trim().split('\t')[0];
        i += 2; continue;
      }
      if (cur.startsWith('+++ ')) { i++; continue; }
      if (cur.startsWith('rename from ')) { oldPath = cur.slice(12).trim(); i++; continue; }
      if (cur.startsWith('rename to ')) { newPath = cur.slice(10).trim(); i++; continue; }
      if (cur === 'new file mode') { isCreation = true; i++; continue; }
      if (cur === 'deleted file mode') { isDeletion = true; i++; continue; }
      i++;
    }
    
    const cleanPath = (p: string) => { if (!p || p === '/dev/null') return p; return (p.startsWith('a/') || p.startsWith('b/')) ? p.slice(2) : p; };
    let opOld = cleanPath(oldPath), opNew = cleanPath(newPath);
    if (opOld === '/dev/null') isCreation = true;
    if (opNew === '/dev/null') isDeletion = true;
    let targetPath = opOld !== '/dev/null' ? opOld : opNew;
    let finalNewPath = (opOld !== opNew && opOld !== '/dev/null' && opNew !== '/dev/null') ? opNew : undefined;
    if (isCreation && opOld === '/dev/null') targetPath = opNew;
    if (isDeletion && opNew === '/dev/null') targetPath = opOld;
    if (!targetPath || targetPath === '/dev/null') { i++; continue; }
    
    const hunks: { o: string[]; n: string[]; hasEol: boolean; a: number; body?: { type: string; text: string }[] }[] = [];
    while (i < lines.length) {
      if (lines[i].startsWith('diff --git ') || (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i+1].startsWith('+++ '))) break;
      if (lines[i].startsWith('@@')) {
        const m = lines[i].match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (!m) return { ops: [], error: { line: i + 1 } };
        const aVal = parseInt(m[1], 10);
        i++;
        const hunkBody: { type: string; text: string }[] = [];
        while (i < lines.length) {
          const hLine = lines[i];
          if (hLine.startsWith('@@ ') || hLine.startsWith('diff --git ') || (hLine.startsWith('--- ') && i + 1 < lines.length && lines[i+1].startsWith('+++ '))) break;
          if (hLine === '\\ No newline at end of file') { hunkBody.push({ type: '\\', text: '' }); i++; continue; }
          if (hLine.length === 0 || hLine[0] === ' ' || hLine[0] === '-' || hLine[0] === '+') {
            const type = hLine.length === 0 ? ' ' : hLine[0];
            const text = hLine.length === 0 ? '' : hLine.slice(1);
            hunkBody.push({ type, text });
            i++; continue;
          }
          break;
        }
        while (hunkBody.length > 0 && hunkBody[hunkBody.length - 1].type === ' ' && hunkBody[hunkBody.length - 1].text === '') hunkBody.pop();
        let oLines: string[] = [], nLines: string[] = [], hasEol = true;
        for (let bi = 0; bi < hunkBody.length; bi++) {
          const hb = hunkBody[bi];
          if (hb.type === ' ') { oLines.push(hb.text); nLines.push(hb.text); }
          else if (hb.type === '-') { oLines.push(hb.text); }
          else if (hb.type === '+') { nLines.push(hb.text); }
          else if (hb.type === '\\') { if (bi > 0) hasEol = false; }
        }
        hunks.push({ o: oLines, n: nLines, hasEol, a: aVal, body: hunkBody });
        continue;
      }
      i++;
    }
    ops.push({ type: isCreation ? 'create' : isDeletion ? 'delete' : finalNewPath ? 'rename' : 'update', path: targetPath, newPath: finalNewPath, hunks });
  }
  return { ops };
}

function parseSearchReplace(patchText: string): { ops: EditOp[]; error?: { line: number } } {
  const lines = patchText.split('\n').map(l => l.replace(/\r$/, ''));
  const ops: EditOp[] = [];
  let i = 0, lastPath = '';
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      let foundPath = '';
      for (let pIdx = i - 1; pIdx >= 0; pIdx--) {
        const pLine = lines[pIdx].trim();
        if (pLine !== '' && !pLine.startsWith('```') && !pLine.startsWith('>>>>>>> REPLACE')) { foundPath = pLine; break; }
        if (pLine.startsWith('>>>>>>> REPLACE')) break;
      }
      if (!foundPath && lastPath) foundPath = lastPath;
      if (!foundPath) return { ops: [], error: { line: searchLineNum } };
      lastPath = foundPath;
      i++;
      const oldLines: string[] = [];
      let foundSeparator = false, sepLineNum = 0;
      while (i < lines.length) {
        if (lines[i].trimEnd() === '=======') { foundSeparator = true; sepLineNum = i + 1; i++; break; }
        oldLines.push(lines[i]);
        i++;
      }
      if (!foundSeparator) return { ops: [], error: { line: searchLineNum } };
      const newLines: string[] = [];
      let foundReplace = false;
      while (i < lines.length) {
        if (lines[i].trimEnd() === '>>>>>>> REPLACE') { foundReplace = true; i++; break; }
        newLines.push(lines[i]);
        i++;
      }
      if (!foundReplace) return { ops: [], error: { line: sepLineNum } };
      if (oldLines.length === 0) ops.push({ type: 'create', path: foundPath, content: newLines });
      else ops.push({ type: 'update', path: foundPath, hunks: [{ o: oldLines, n: newLines, hasEol: true }] });
      continue;
    }
    i++;
  }
  return { ops };
}

function parseV4a(patchText: string): { ops: EditOp[]; error?: { line: number } } {
  const lines = patchText.split('\n').map(l => l.replace(/\r$/, ''));
  let firstIdx = -1, firstText = '';
  for (let idx = 0; idx < lines.length; idx++) { if (lines[idx].trim() !== '') { firstIdx = idx; firstText = lines[idx].trim(); break; } }
  if (firstText !== '*** Begin Patch') return { ops: [], error: { line: firstIdx >= 0 ? firstIdx + 1 : 1 } };
  let lastIdx = -1, lastText = '';
  for (let idx = lines.length - 1; idx >= 0; idx--) { if (lines[idx].trim() !== '') { lastIdx = idx; lastText = lines[idx].trim(); break; } }
  if (lastText !== '*** End Patch') return { ops: [], error: { line: lines.length } };
  
  const ops: EditOp[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    if (lines[i].trim() === '') { i++; continue; }
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*** Add File:')) {
      const fPath = trimmed.slice(13).trim();
      i++;
      const addLines: string[] = [];
      while (i < lastIdx) {
        if (lines[i].trim().startsWith('***')) break;
        if (lines[i].startsWith('+')) { addLines.push(lines[i].slice(1)); i++; }
        else if (lines[i] === '') {
           let peek = i, hasMore = false;
           while(peek < lastIdx) { if(lines[peek].trim() !== '') { if(lines[peek].trim().startsWith('***')) break; hasMore = true; break; } peek++; }
           if(hasMore) { addLines.push(''); i++; } else break;
        } else return { ops: [], error: { line: i + 1 } };
      }
      ops.push({ type: 'create', path: fPath, content: addLines });
    } else if (trimmed.startsWith('*** Delete File:')) {
      ops.push({ type: 'delete', path: trimmed.slice(16).trim() }); i++;
    } else if (trimmed.startsWith('*** Update File:')) {
      const fPath = trimmed.slice(16).trim();
      const updateLine = i + 1;
      i++;
      let movePath: string | undefined;
      while (i < lastIdx && lines[i].trim() === '') i++;
      if (i < lastIdx && lines[i].trim().startsWith('*** Move to:')) { movePath = lines[i].trim().slice(12).trim(); i++; }
      const chunks: { anchor?: string; o: string[]; n: string[]; isEof?: boolean; body?: { type: string; text: string }[] }[] = [];
      while (i < lastIdx) {
        if (lines[i].trim() === '') { i++; continue; }
        if (lines[i].trim().startsWith('***')) break;
        let anchor: string | undefined;
        if (lines[i].trim().startsWith('@@')) { anchor = lines[i].trim().slice(2).trim(); i++; }
        const chunkBody: { type: string; text: string }[] = [];
        let isEof = false;
        while (i < lastIdx) {
          const bLine = lines[i];
          const bTrim = bLine.trim();
          if (bTrim === '' || bTrim.startsWith('@@') || bTrim.startsWith('*** End of File') || bTrim.startsWith('***')) {
            if (bTrim.startsWith('*** End of File')) { isEof = true; i++; }
            break;
          }
          if (bLine.startsWith(' ') || bLine.startsWith('-') || bLine.startsWith('+')) { chunkBody.push({ type: bLine[0], text: bLine.slice(1) }); i++; }
          else if (bLine === '') { chunkBody.push({ type: ' ', text: '' }); i++; }
          else break;
        }
        while (chunkBody.length > 0 && chunkBody[chunkBody.length - 1].type === ' ' && chunkBody[chunkBody.length - 1].text === '') chunkBody.pop();
        if (!anchor && chunkBody.length === 0 && !isEof) { if (chunks.length === 0 && !movePath) return { ops: [], error: { line: updateLine } }; break; }
        let oLines: string[] = [], nLines: string[] = [];
        for (const cb of chunkBody) {
          if (cb.type === ' ') { oLines.push(cb.text); nLines.push(cb.text); }
          else if (cb.type === '-') { oLines.push(cb.text); }
          else if (cb.type === '+') { nLines.push(cb.text); }
        }
        chunks.push({ anchor, o: oLines, n: nLines, isEof, body: chunkBody });
        if (isEof) break;
      }
      ops.push({ type: movePath ? 'rename' : 'update', path: fPath, newPath: movePath, chunks });
    } else return { ops: [], error: { line: i + 1 } };
  }
  return { ops };
}

function parseJsonEdits(patchText: string): { ops: EditOp[]; error?: { line: number } } {
  const trimmed = patchText.trim();
  const lines = patchText.split('\n');
  if (trimmed.startsWith('[')) {
    let startLine = 1;
    for (let idx = 0; idx < lines.length; idx++) { if (lines[idx].trim().startsWith('[')) { startLine = idx + 1; break; } }
    let arr: any;
    try { arr = JSON.parse(patchText); } catch (e) { return { ops: [], error: { line: startLine } }; }
    if (!Array.isArray(arr)) return { ops: [], error: { line: startLine } };
    const ops: EditOp[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return { ops: [], error: { line: startLine } };
      const cmd = item.command, p = item.path;
      if (!p || typeof p !== 'string') return { ops: [], error: { line: startLine } };
      if (cmd === 'create' && typeof item.file_text === 'string') ops.push({ type: 'create', path: p, fileText: item.file_text });
      else if (cmd === 'str_replace' && typeof item.old_str === 'string' && item.old_str !== '' && (item.new_str === undefined || typeof item.new_str === 'string')) ops.push({ type: 'update', path: p, oldStr: item.old_str, newStr: item.new_str || '' });
      else if (cmd === 'insert' && Number.isInteger(item.insert_line) && typeof item.new_str === 'string') ops.push({ type: 'update', path: p, insertLine: item.insert_line, newStr: item.new_str });
      else return { ops: [], error: { line: startLine } };
    }
    return { ops };
  } else {
    const ops: EditOp[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx].replace(/\r$/, '');
      if (l.trim() === '') continue;
      let item: any;
      try { item = JSON.parse(l); } catch (e) { return { ops: [], error: { line: idx + 1 } }; }
      if (!item || typeof item !== 'object' || Array.isArray(item)) return { ops: [], error: { line: idx + 1 } };
      const cmd = item.command, p = item.path;
      if (!p || typeof p !== 'string') return { ops: [], error: { line: idx + 1 } };
      if (cmd === 'create' && typeof item.file_text === 'string') ops.push({ type: 'create', path: p, fileText: item.file_text });
      else if (cmd === 'str_replace' && typeof item.old_str === 'string' && item.old_str !== '' && (item.new_str === undefined || typeof item.new_str === 'string')) ops.push({ type: 'update', path: p, oldStr: item.old_str, newStr: item.new_str || '' });
      else if (cmd === 'insert' && Number.isInteger(item.insert_line) && typeof item.new_str === 'string') ops.push({ type: 'update', path: p, insertLine: item.insert_line, newStr: item.new_str });
      else return { ops: [], error: { line: idx + 1 } };
    }
    return { ops };
  }
}

// Build replacement lines from a parsed hunk/chunk BODY (raw lines with types).
// Unlike aligning o vs n (which cannot tell a '-x'/'+x' pair from a context
// line), the body knows each line's role:
//  - context lines (' ') emit the FILE's own matched line (SPEC rule: a context
//    line is never rewritten from the patch);
//  - '-' lines are dropped;
//  - '+' lines emit the patch's text, re-indented at tier 2 per SPEC section 5
//    (P = O's first line's leading whitespace, F = the file's first matched
//    line's leading whitespace; a non-empty '+' line starting with P has P
//    replaced by F — when P is empty, F is prepended).
function buildFromBody(
  body: { type: string; text: string }[],
  oLines: string[],
  fileLines: string[],
  tier: number
): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const pIndent = tier === 2 && oLines.length > 0 ? (oLines[0].match(/^[ \t]*/)?.[0] ?? '') : '';
  const fIndent = tier === 2 && fileLines.length > 0 ? (fileLines[0].match(/^[ \t]*/)?.[0] ?? '') : '';
  // SPEC section 5: at tier 2, every non-context line of N that is not empty
  // and not only whitespace, and starts with P (O's first line's leading
  // whitespace), has that P replaced by F (the file's first matched line's
  // leading whitespace). When P is empty, every such line "starts with P",
  // so F is prepended.
  const reindent = (txt: string): string => {
    if (tier !== 2) return txt;
    if (txt === '' || txt.trim() === '') return txt;
    if (txt.startsWith(pIndent)) return fIndent + txt.slice(pIndent.length);
    return txt;
  };
  let i = 0;
  while (i < body.length) {
    const b = body[i];
    if (b.type === ' ') {
      out.push(fileLines[oIdx] ?? b.text);
      oIdx++; i++;
    } else if (b.type === '-') {
      oIdx++; i++;
    } else if (b.type === '+') {
      out.push(reindent(b.text));
      i++;
    } else {
      // '\' no-newline marker: no output, no o-line consumed.
      i++;
    }
  }
  return out;
}

// Prefer the body-based replacement when the parser kept the raw body
// (unified hunks and V4A chunks); fall back to LCS alignment for
// SEARCH/REPLACE blocks, which have no body.
function buildReplacement(
  hc: { o: string[]; n: string[]; body?: { type: string; text: string }[] },
  fileLines: string[],
  tier: number
): string[] {
  if (hc.body) return buildFromBody(hc.body, hc.o, fileLines, tier);
  return reconcileReplace(hc.o, hc.n, fileLines, tier);
}

// Apply V4A chunks to file content. Returns the new content or a failure reason.
function applyChunks(content: string, chunks: { anchor?: string; o: string[]; n: string[]; isEof?: boolean; body?: { type: string; text: string }[] }[], strict: boolean): { ok: true; content: string } | { ok: false; reason: string } {
  const fc = parseFile(content);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.isEof) {
      if (chunk.anchor) {
        let matchIdx = -1;
        for (const fn of [locateGrade0, locateGrade1, locateGrade2]) {
          for (const m of fn(fc.lines, [chunk.anchor])) { if (m + 1 === fc.lines.length) { matchIdx = m; break; } }
          if (matchIdx !== -1) break;
        }
        if (matchIdx === -1) return { ok: false, reason: 'no-match' };
        cursor = matchIdx + 1;
        // The anchor is the file's last line, so o-lines after it cannot match.
        if (chunk.o.length > 0) return { ok: false, reason: 'no-match' };
        fc.lines.splice(cursor, 0, ...chunk.n); cursor += chunk.n.length;
        continue;
      }
      // No anchor: the o-lines must match the file's FINAL lines.
      if (chunk.o.length === 0) {
        cursor = fc.lines.length;
        fc.lines.splice(cursor, 0, ...chunk.n); cursor += chunk.n.length;
        continue;
      }
      let eofIdx = -1, eofTier = -1;
      for (const t of (strict ? [0] : [0, 1, 2])) {
        const fn = t === 0 ? locateGrade0 : t === 1 ? locateGrade1 : locateGrade2;
        for (const m of fn(fc.lines, chunk.o)) {
          if (m + chunk.o.length === fc.lines.length) { eofIdx = m; eofTier = t; break; }
        }
        if (eofIdx !== -1) break;
      }
      if (eofIdx === -1) return { ok: false, reason: 'no-match' };
      const transN = buildReplacement(chunk, fc.lines.slice(eofIdx, eofIdx + chunk.o.length), eofTier);
      fc.lines.splice(eofIdx, chunk.o.length, ...transN);
      cursor = eofIdx + transN.length;
      continue;
    }
    if (chunk.anchor) {
      let foundMatch: { index: number; tier: number } | null = null;
      for (const t of (strict ? [0] : [0, 1, 2])) {
        const fn = t === 0 ? locateGrade0 : t === 1 ? locateGrade1 : locateGrade2;
        const matches = fn(fc.lines.slice(cursor), [chunk.anchor]);
        if (matches.length > 0) { foundMatch = { index: cursor + matches[0], tier: t }; break; }
      }
      if (!foundMatch) return { ok: false, reason: 'no-match' };
      cursor = foundMatch.index + 1;
    }
    if (chunk.o.length > 0) {
      const occ = locateInstance(fc.lines.slice(cursor), chunk.o, strict);
      if (!occ) return { ok: false, reason: 'no-match' };
      const absIndex = cursor + occ.index;
      const transN = buildReplacement(chunk, fc.lines.slice(absIndex, absIndex + chunk.o.length), occ.tier);
      fc.lines.splice(absIndex, chunk.o.length, ...transN);
      cursor = absIndex + transN.length;
    } else { fc.lines.splice(cursor, 0, ...chunk.n); cursor += chunk.n.length; }
  }
  return { ok: true, content: serializeFile(fc) };
}

// Apply unified hunks to file content. Returns the new content or a failure reason.
function applyHunks(content: string, hunks: { o: string[]; n: string[]; hasEol: boolean; a?: number; body?: { type: string; text: string }[] }[], strict: boolean): { ok: true; content: string } | { ok: false; reason: string } {
  const fc = parseFile(content);
  let hunkSumD = 0;
  for (const hunk of hunks) {
    const oLinesCleaned = hunk.o;
    const nLinesCleaned = hunk.n;
    if (oLinesCleaned.length === 0) {
      const insertPos = Math.min(fc.lines.length, (hunk.a ?? 0) + hunkSumD);
      fc.lines.splice(insertPos, 0, ...nLinesCleaned);
      if (!hunk.hasEol) fc.hasEol = false;
      hunkSumD += nLinesCleaned.length - oLinesCleaned.length;
    } else {
      let matches: { index: number; tier: number }[] = [];
      const fn = (t: number) => t === 0 ? locateGrade0 : t === 1 ? locateGrade1 : locateGrade2;
      for (const t of (strict ? [0] : [0, 1, 2])) {
        const res = fn(t)(fc.lines, oLinesCleaned);
        if (res.length > 0) { matches = res.map(idx => ({ index: idx, tier: t })); break; }
      }
      if (matches.length === 0) return { ok: false, reason: 'no-match' };
      const isSearchReplaceBlock = hunk.a === undefined;
      if (isSearchReplaceBlock && matches.length > 1) {
        const firstTier = matches[0].tier;
        const sameTierMatches = matches.filter(m => m.tier === firstTier);
        if (sameTierMatches.length > 1) return { ok: false, reason: 'ambiguous' };
        matches = [sameTierMatches[0]];
      }
      let bestMatch = matches[0];
      if (hunk.a !== undefined) {
        const targetPos = hunk.a - 1 + hunkSumD;
        let minDist = Math.abs(bestMatch.index - targetPos);
        for (let mi = 1; mi < matches.length; mi++) {
          const dist = Math.abs(matches[mi].index - targetPos);
          if (dist < minDist) { minDist = dist; bestMatch = matches[mi]; }
        }
      }
      const transN = buildReplacement(hunk, fc.lines.slice(bestMatch.index, bestMatch.index + oLinesCleaned.length), bestMatch.tier);
      fc.lines.splice(bestMatch.index, oLinesCleaned.length, ...transN);
      if (!hunk.hasEol) fc.hasEol = false;
      hunkSumD += transN.length - oLinesCleaned.length;
    }
  }
  return { ok: true, content: serializeFile(fc) };
}

function runEdits(ops: EditOp[], strict: boolean): ExecutionResult {
  const files = new Map<string, string>();
  function scanDir(dir: string, base: string) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === '.makefun') continue;
      const rel = base ? `${base}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scanDir(full, rel);
      else if (ent.isFile()) { try { files.set(rel, fs.readFileSync(full, 'utf8')); } catch (e) {} }
    }
  }
  scanDir('.', '');
  const fileChanges = new Map<string, any>();
  const errorLines: string[] = [];
  
  for (const op of ops) {
    if (!isSafePath(op.path)) { errorLines.push(`unsafe ${op.path}`); continue; }
    if (op.newPath && !isSafePath(op.newPath)) { errorLines.push(`unsafe ${op.newPath}`); continue; }
    if (op.type === 'create') {
      if (files.has(op.path)) { errorLines.push(`exists ${op.path}`); continue; }
      let newText = op.fileText ?? (op.content ? op.content.join('\n') + (op.content.length > 0 ? '\n' : '') : (op.hunks ? op.hunks.map(h=>h.n.join('\n')+(h.hasEol && h.n.length > 0 ? '\n' : '')).join('') : ''));
      files.set(op.path, newText); fileChanges.set(op.path, { type: 'A', content: newText });
    } else if (op.type === 'delete') {
      if (!files.has(op.path)) { errorLines.push(`missing ${op.path}`); continue; }
      files.delete(op.path); fileChanges.set(op.path, { type: 'D' });
    } else if (op.type === 'rename') {
      if (!files.has(op.path)) { errorLines.push(`missing ${op.path}`); continue; }
      if (files.has(op.newPath!)) { errorLines.push(`exists ${op.newPath!}`); continue; }
      let content = files.get(op.path)!;
      // A rename may carry content changes (unified hunks or V4A chunks) — apply
      // them to the content before moving it to the new path.
      if (op.hunks && op.hunks.length > 0) {
        const r = applyHunks(content, op.hunks, strict);
        if (!r.ok) { errorLines.push(`${r.reason} ${op.path}`); continue; }
        content = r.content;
      } else if (op.chunks && op.chunks.length > 0) {
        const r = applyChunks(content, op.chunks, strict);
        if (!r.ok) { errorLines.push(`${r.reason} ${op.path}`); continue; }
        content = r.content;
      }
      files.delete(op.path); files.set(op.newPath!, content);
      fileChanges.set(op.newPath!, { type: 'R', oldPath: op.path, newPath: op.newPath, content });
      fileChanges.delete(op.path);
    } else if (op.type === 'update') {
      if (!files.has(op.path)) { errorLines.push(`missing ${op.path}`); continue; }
      let content = files.get(op.path)!;
      if (op.oldStr !== undefined) {
        const isCrlf = content.includes('\r\n');
        let textNorm = isCrlf ? content.replace(/\r\n/g, '\n') : content;
        const oldNorm = op.oldStr.replace(/\r\n/g, '\n'), newNorm = op.newStr!.replace(/\r\n/g, '\n');
        let count = 0, pos = textNorm.indexOf(oldNorm);
        while (pos !== -1) { count++; pos = textNorm.indexOf(oldNorm, pos + 1); }
        if (count === 0) { errorLines.push(`no-match ${op.path}`); continue; }
        if (count > 1) { errorLines.push(`ambiguous ${op.path}`); continue; }
        textNorm = textNorm.replace(oldNorm, newNorm);
        content = isCrlf ? textNorm.replace(/\n/g, '\r\n') : textNorm;
        files.set(op.path, content); fileChanges.set(op.path, { type: 'M', content });
      } else if (op.insertLine !== undefined) {
        const fc = parseFile(content);
        if (op.insertLine < 0 || op.insertLine > fc.lines.length) { errorLines.push(`no-match ${op.path}`); continue; }
        const insertStrs = op.newStr.split('\n').map(l => l.replace(/\r$/, ''));
        if (op.newStr.endsWith('\n') && insertStrs.length > 0 && insertStrs[insertStrs.length - 1] === '') insertStrs.pop();
        if (op.newStr === '') insertStrs.length = 0;
        fc.lines.splice(op.insertLine, 0, ...insertStrs);
        content = serializeFile(fc);
        files.set(op.path, content); fileChanges.set(op.path, { type: 'M', content });
      } else if (op.chunks) {
        const fc = parseFile(content);
        let cursor = 0, failed = false, failReason = '';
        for (const chunk of op.chunks) {
          if (chunk.isEof) {
            if (chunk.anchor) {
              const matches = locateGrade0(fc.lines, [chunk.anchor]);
              let matchIdx = -1;
              for (const m of matches) { if (m + 1 === fc.lines.length) { matchIdx = m; break; } }
              if (matchIdx === -1) { const t1 = locateGrade1(fc.lines, [chunk.anchor]); for (const m of t1) { if (m + 1 === fc.lines.length) { matchIdx = m; break; } } }
              if (matchIdx === -1) { const t2 = locateGrade2(fc.lines, [chunk.anchor]); for (const m of t2) { if (m + 1 === fc.lines.length) { matchIdx = m; break; } } }
              if (matchIdx === -1) { failed = true; failReason = 'no-match'; break; }
              cursor = matchIdx + 1;
              // The anchor is the file's last line, so o-lines after it cannot match.
              if (chunk.o.length > 0) { failed = true; failReason = 'no-match'; break; }
              fc.lines.splice(cursor, 0, ...chunk.n); cursor += chunk.n.length;
              continue;
            }
            // No anchor: the o-lines must match the file's FINAL lines.
            if (chunk.o.length === 0) {
              cursor = fc.lines.length;
              fc.lines.splice(cursor, 0, ...chunk.n); cursor += chunk.n.length;
              continue;
            }
            let eofIdx = -1, eofTier = -1;
            for (const t of (strict ? [0] : [0, 1, 2])) {
              const fn = t === 0 ? locateGrade0 : t === 1 ? locateGrade1 : locateGrade2;
              for (const m of fn(fc.lines, chunk.o)) {
                if (m + chunk.o.length === fc.lines.length) { eofIdx = m; eofTier = t; break; }
              }
              if (eofIdx !== -1) break;
            }
            if (eofIdx === -1) { failed = true; failReason = 'no-match'; break; }
            const transN = buildReplacement(chunk, fc.lines.slice(eofIdx, eofIdx + chunk.o.length), eofTier);
            fc.lines.splice(eofIdx, chunk.o.length, ...transN);
            cursor = eofIdx + transN.length;
            continue;
          }
          if (chunk.anchor) {
            let foundMatch: { index: number; tier: number } | null = null;
            for (const t of (strict ? [0] : [0, 1, 2])) {
              const fn = t === 0 ? locateGrade0 : t === 1 ? locateGrade1 : locateGrade2;
              const matches = fn(fc.lines.slice(cursor), [chunk.anchor]);
              if (matches.length > 0) { foundMatch = { index: cursor + matches[0], tier: t }; break; }
            }
            if (!foundMatch) { failed = true; failReason = 'no-match'; break; }
            cursor = foundMatch.index + 1;
          }
          if (chunk.o.length > 0) {
             const occ = locateInstance(fc.lines.slice(cursor), chunk.o, strict);
             if (!occ) { failed = true; failReason = 'no-match'; break; }
             const absIndex = cursor + occ.index;
             const transN = buildReplacement(chunk, fc.lines.slice(absIndex, absIndex + chunk.o.length), occ.tier);
             fc.lines.splice(absIndex, chunk.o.length, ...transN);
             cursor = absIndex + transN.length;
          } else { fc.lines.splice(cursor, 0, ...chunk.n); cursor += chunk.n.length; }
        }
        if (failed) { errorLines.push(`${failReason} ${op.path}`); continue; }
        content = serializeFile(fc); files.set(op.path, content); fileChanges.set(op.path, { type: 'M', content });
      } else if (op.hunks) {
        const fc = parseFile(content);
        let hunkSumD = 0, failed = false, failReason = '';
        for (const hunk of op.hunks) {
          const oLines = hunk.o.map(l => l.startsWith(' ') ? l.slice(1) : l.startsWith('-') ? l.slice(1) : l); // fix trailing space/prefix issue: actually strip ONE space if it's a context line
          // Actually, simply remove first char if it was a context/old line
          const oLinesCleaned = hunk.o;
          const nLinesCleaned = hunk.n;
          // Spec: "A context line... is written as the file's own matched line, never the patch's."
          // So if we have -old, we look for old. If we have +new, we write new.
          // The current implementation splits lines into oLines and nLines, which already strips the prefix. This looks okay.
          
          if (oLinesCleaned.length === 0) {
            const insertPos = Math.min(fc.lines.length, (hunk.a ?? 0) + hunkSumD);
            fc.lines.splice(insertPos, 0, ...nLinesCleaned);
            if (!hunk.hasEol) fc.hasEol = false;
            hunkSumD += nLinesCleaned.length - oLinesCleaned.length;
          } else {
            let matches: { index: number; tier: number }[] = [];
            const fn = (t: number) => t === 0 ? locateGrade0 : t === 1 ? locateGrade1 : locateGrade2;
            for (const t of (strict ? [0] : [0, 1, 2])) {
              const res = fn(t)(fc.lines, oLinesCleaned);
              if (res.length > 0) { matches = res.map(idx => ({ index: idx, tier: t })); break; }
            }
            if (matches.length === 0) { failed = true; failReason = 'no-match'; break; }
            const isSearchReplaceBlock = hunk.a === undefined;
            if (isSearchReplaceBlock && matches.length > 1) {
              const firstTier = matches[0].tier;
              const sameTierMatches = matches.filter(m => m.tier === firstTier);
              if (sameTierMatches.length > 1) { failed = true; failReason = 'ambiguous'; break; }
              matches = [sameTierMatches[0]];
            }
            let bestMatch = matches[0];
            if (hunk.a !== undefined) {
              const targetPos = hunk.a - 1 + hunkSumD;
              let minDist = Math.abs(bestMatch.index - targetPos);
              for (let mi = 1; mi < matches.length; mi++) {
                const dist = Math.abs(matches[mi].index - targetPos);
                if (dist < minDist) { minDist = dist; bestMatch = matches[mi]; }
              }
            }
            const transN = buildReplacement(hunk, fc.lines.slice(bestMatch.index, bestMatch.index + oLinesCleaned.length), bestMatch.tier);
            fc.lines.splice(bestMatch.index, oLinesCleaned.length, ...transN);
            if (!hunk.hasEol) fc.hasEol = false;
            hunkSumD += transN.length - oLinesCleaned.length;
          }
        }
        if (failed) { errorLines.push(`${failReason || 'no-match'} ${op.path}`); continue; }
        content = serializeFile(fc); files.set(op.path, content); fileChanges.set(op.path, { type: 'M', content });
      }
    }
  }
  return { success: errorLines.length === 0, fileChanges, errorLines };
}

async function main() {
  const args = process.argv.slice(2);
  let formatArg = 'auto', checkOnly = false, strictMode = false, patchPath: string | null = null;
  let parsingOptions = true, positionalCount = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (parsingOptions && arg === '--') { parsingOptions = false; continue; }
    if (parsingOptions && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        const val = arg.slice(9);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(val)) { console.log('error: usage'); process.exit(2); }
        formatArg = val;
      } else if (arg === '--check') { checkOnly = true; }
      else if (arg === '--strict') { strictMode = true; }
      else { console.log('error: usage'); process.exit(2); }
    } else {
      positionalCount++;
      if (positionalCount > 1) { console.log('error: usage'); process.exit(2); }
      patchPath = arg;
    }
  }
  let patchText = '';
  try {
    if (!patchPath || patchPath === '-') patchText = fs.readFileSync(0, 'utf8');
    else patchText = fs.readFileSync(patchPath, 'utf8');
  } catch (e) { console.log('error: no-patch'); process.exit(2); }
  
  let fmt = formatArg === 'auto' ? detectFormat(patchText) : formatArg;
  if (fmt === 'unknown') { console.log('error: format'); process.exit(2); }
  let parseRes = fmt === 'unified' ? parseUnified(patchText) : fmt === 'search-replace' ? parseSearchReplace(patchText) : fmt === 'v4a' ? parseV4a(patchText) : parseJsonEdits(patchText);
  if (parseRes.error) { console.log(`error: parse ${parseRes.error.line}`); process.exit(2); }
  if (parseRes.ops.length === 0) { console.log('error: parse 1'); process.exit(2); }
  const execRes = runEdits(parseRes.ops, strictMode);
  if (!execRes.success) {
    for (const errLine of execRes.errorLines) console.log(`error: ${errLine}`);
    console.log(`failed: ${execRes.errorLines.length} of ${parseRes.ops.length} edits`);
    process.exit(1);
  }
  const finalFileActions: { path: string; line: string }[] = [];
  for (const [p, change] of execRes.fileChanges.entries()) {
    const full = path.join('.', p);
    let orig = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    let newB = change.content ?? (fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '');
    if (change.type === 'A' && orig !== newB) finalFileActions.push({ path: p, line: `A ${p}` });
    else if (change.type === 'D' && fs.existsSync(full)) finalFileActions.push({ path: p, line: `D ${p}` });
    else if (change.type === 'M' && orig !== newB) finalFileActions.push({ path: p, line: `M ${p}` });
    else if (change.type === 'R') finalFileActions.push({ path: change.newPath!, line: `R ${change.oldPath} -> ${change.newPath}` });
  }
  finalFileActions.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!checkOnly) {
    for (const [p, change] of execRes.fileChanges.entries()) {
      const full = path.join('.', p);
      if (change.type === 'D') { if (fs.existsSync(full)) fs.unlinkSync(full); }
      else if (change.type === 'R') { if (fs.existsSync(path.join('.', change.oldPath!))) fs.unlinkSync(path.join('.', change.oldPath!)); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, change.content!); }
      else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, change.content!); }
    }
  }
  for (const act of finalFileActions) console.log(act.line);
  console.log(`ok: ${finalFileActions.length} ${finalFileActions.length === 1 ? 'file' : 'files'}`);
  process.exit(0);
}
main();
