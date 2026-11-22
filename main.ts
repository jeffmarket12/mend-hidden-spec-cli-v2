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
  const sourceLines = patchText.split('\n').map(l => l.replace(/\r$/, ''));
  const collectedOps: EditOp[] = [];
  let cursor = 0;
  while (cursor < sourceLines.length) {
    const activeLine = sourceLines[cursor];
    const isGitPatch = activeLine.startsWith('diff --git ');
    const isPairHeader = activeLine.startsWith('--- ') && cursor + 1 < sourceLines.length && sourceLines[cursor + 1].startsWith('+++ ');
    if (!isGitPatch && !isPairHeader) { cursor++; continue; }

    let origPath = '', destPath = '', isNewFile = false, isDelFile = false;
    if (isGitPatch) {
      const segs = activeLine.slice(11).trim().split(/\s+/);
      if (segs.length >= 2) { origPath = segs[0]; destPath = segs[1]; }
      cursor++;
    } else {
      origPath = sourceLines[cursor].slice(4).trim().split('\t')[0];
      destPath = sourceLines[cursor + 1].slice(4).trim().split('\t')[0];
      cursor += 2;
    }

    while (cursor < sourceLines.length) {
      const row = sourceLines[cursor];
      if (row.startsWith('@@ ') || row.startsWith('diff --git ')) break;
      if (row.startsWith('--- ')) {
        if (cursor + 1 >= sourceLines.length || !sourceLines[cursor + 1].startsWith('+++ ')) return { ops: [], error: { line: cursor + 2 } };
        origPath = row.slice(4).trim().split('\t')[0];
        destPath = sourceLines[cursor + 1].slice(4).trim().split('\t')[0];
        cursor += 2;
        continue;
      }
      if (row.startsWith('+++ ')) { cursor++; continue; }
      if (row.startsWith('rename from ')) { origPath = row.slice(12).trim(); cursor++; continue; }
      if (row.startsWith('rename to ')) { destPath = row.slice(10).trim(); cursor++; continue; }
      if (row === 'new file mode') { isNewFile = true; cursor++; continue; }
      if (row === 'deleted file mode') { isDelFile = true; cursor++; continue; }
      cursor++;
    }

    const sanitizePath = (p: string) => { if (!p || p === '/dev/null') return p; return (p.startsWith('a/') || p.startsWith('b/')) ? p.slice(2) : p; };
    let cleanOrig = sanitizePath(origPath), cleanDest = sanitizePath(destPath);
    if (cleanOrig === '/dev/null') isNewFile = true;
    if (cleanDest === '/dev/null') isDelFile = true;
    let finalTarget = cleanOrig !== '/dev/null' ? cleanOrig : cleanDest;
    let finalRename = (cleanOrig !== cleanDest && cleanOrig !== '/dev/null' && cleanDest !== '/dev/null') ? cleanDest : undefined;
    if (isNewFile && cleanOrig === '/dev/null') finalTarget = cleanDest;
    if (isDelFile && cleanDest === '/dev/null') finalTarget = cleanOrig;
    if (!finalTarget || finalTarget === '/dev/null') { cursor++; continue; }

    const parsedHunks: { o: string[]; n: string[]; hasEol: boolean; a: number; body?: { type: string; text: string }[] }[] = [];
    while (cursor < sourceLines.length) {
      if (sourceLines[cursor].startsWith('diff --git ') || (sourceLines[cursor].startsWith('--- ') && cursor + 1 < sourceLines.length && sourceLines[cursor + 1].startsWith('+++ '))) break;
      if (sourceLines[cursor].startsWith('@@')) {
        const hunkMatch = sourceLines[cursor].match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (!hunkMatch) return { ops: [], error: { line: cursor + 1 } };
        const anchorA = parseInt(hunkMatch[1], 10);
        cursor++;
        const contentRows: { type: string; text: string }[] = [];
        while (cursor < sourceLines.length) {
          const contentLine = sourceLines[cursor];
          if (contentLine.startsWith('@@ ') || contentLine.startsWith('diff --git ') || (contentLine.startsWith('--- ') && cursor + 1 < sourceLines.length && sourceLines[cursor + 1].startsWith('+++ '))) break;
          if (contentLine === '\\ No newline at end of file') { contentRows.push({ type: '\\', text: '' }); cursor++; continue; }
          if (contentLine.length === 0 || contentLine[0] === ' ' || contentLine[0] === '-' || contentLine[0] === '+') {
            const t = contentLine.length === 0 ? ' ' : contentLine[0];
            const txt = contentLine.length === 0 ? '' : contentLine.slice(1);
            contentRows.push({ type: t, text: txt });
            cursor++;
            continue;
          }
          break;
        }
        while (contentRows.length > 0 && contentRows[contentRows.length - 1].type === ' ' && contentRows[contentRows.length - 1].text === '') contentRows.pop();
        let extractedOld: string[] = [], extractedNew: string[] = [], eolState = true;
        for (let idx = 0; idx < contentRows.length; idx++) {
          const item = contentRows[idx];
          if (item.type === ' ') { extractedOld.push(item.text); extractedNew.push(item.text); }
          else if (item.type === '-') { extractedOld.push(item.text); }
          else if (item.type === '+') { extractedNew.push(item.text); }
          else if (item.type === '\\') { if (idx > 0) eolState = false; }
        }
        parsedHunks.push({ o: extractedOld, n: extractedNew, hasEol: eolState, a: anchorA, body: contentRows });
        continue;
      }
      cursor++;
    }
    collectedOps.push({ type: isNewFile ? 'create' : isDelFile ? 'delete' : finalRename ? 'rename' : 'update', path: finalTarget, newPath: finalRename, hunks: parsedHunks });
  }
  return { ops: collectedOps };
}

function parseSearchReplace(patchText: string): { ops: EditOp[]; error?: { line: number } } {
  const sourceLines = patchText.split('\n').map(l => l.replace(/\r$/, ''));
  const collectedOps: EditOp[] = [];
  let cursor = 0, previousPath = '';
  while (cursor < sourceLines.length) {
    if (sourceLines[cursor].trimEnd() === '<<<<<<< SEARCH') {
      const markerRow = cursor + 1;
      let locatedPath = '';
      for (let scanIdx = cursor - 1; scanIdx >= 0; scanIdx--) {
        const candidate = sourceLines[scanIdx].trim();
        if (candidate !== '' && !candidate.startsWith('```') && !candidate.startsWith('>>>>>>> REPLACE')) {
          locatedPath = candidate;
          break;
        }
        if (candidate.startsWith('>>>>>>> REPLACE')) break;
      }
      if (!locatedPath && previousPath) locatedPath = previousPath;
      if (!locatedPath) return { ops: [], error: { line: markerRow } };
      previousPath = locatedPath;

      cursor++;
      const oldBlock: string[] = [];
      while (cursor < sourceLines.length && sourceLines[cursor].trimEnd() !== '=======') {
        oldBlock.push(sourceLines[cursor]);
        cursor++;
      }
      if (cursor >= sourceLines.length || sourceLines[cursor].trimEnd() !== '=======') return { ops: [], error: { line: markerRow } };
      cursor++;

      const newBlock: string[] = [];
      let foundReplace = false;
      while (cursor < sourceLines.length) {
        if (sourceLines[cursor].trimEnd() === '>>>>>>> REPLACE') {
          foundReplace = true;
          cursor++;
          break;
        }
        newBlock.push(sourceLines[cursor]);
        cursor++;
      }
      if (!foundReplace) return { ops: [], error: { line: cursor } };

      if (oldBlock.length === 0) {
        collectedOps.push({ type: 'create', path: locatedPath, content: newBlock });
      } else {
        collectedOps.push({ type: 'update', path: locatedPath, hunks: [{ o: oldBlock, n: newBlock, hasEol: true }] });
      }
    } else {
      cursor++;
    }
  }
  return { ops: collectedOps };
}

function parseV4a(patchText: string): { ops: EditOp[]; error?: { line: number } } {
  const sourceLines = patchText.split('\n').map(l => l.replace(/\r$/, ''));
  let firstValid = -1, firstText = '';
  for (let i = 0; i < sourceLines.length; i++) {
    if (sourceLines[i].trim() !== '') { firstValid = i; firstText = sourceLines[i].trim(); break; }
  }
  if (firstText !== '*** Begin Patch') return { ops: [], error: { line: firstValid >= 0 ? firstValid + 1 : 1 } };
  let lastValid = -1, lastText = '';
  for (let i = sourceLines.length - 1; i >= 0; i--) {
    if (sourceLines[i].trim() !== '') { lastValid = i; lastText = sourceLines[i].trim(); break; }
  }
  if (lastText !== '*** End Patch') return { ops: [], error: { line: sourceLines.length } };

  const collectedOps: EditOp[] = [];
  let cursor = firstValid + 1;
  while (cursor < lastValid) {
    if (sourceLines[cursor].trim() === '') { cursor++; continue; }
    const rowTrim = sourceLines[cursor].trim();
    if (rowTrim.startsWith('*** Add File:')) {
      const fPath = rowTrim.slice(13).trim();
      cursor++;
      const addRows: string[] = [];
      while (cursor < lastValid) {
        if (sourceLines[cursor].trim().startsWith('***')) break;
        if (sourceLines[cursor].startsWith('+')) { addRows.push(sourceLines[cursor].slice(1)); cursor++; }
        else if (sourceLines[cursor] === '') {
          let peekIdx = cursor, hasMoreContent = false;
          while (peekIdx < lastValid) {
            if (sourceLines[peekIdx].trim() !== '') {
              if (sourceLines[peekIdx].trim().startsWith('***')) break;
              hasMoreContent = true;
              break;
            }
            peekIdx++;
          }
          if (hasMoreContent) { addRows.push(''); cursor++; } else break;
        } else return { ops: [], error: { line: cursor + 1 } };
      }
      collectedOps.push({ type: 'create', path: fPath, content: addRows });
    } else if (rowTrim.startsWith('*** Delete File:')) {
      collectedOps.push({ type: 'delete', path: rowTrim.slice(16).trim() });
      cursor++;
    } else if (rowTrim.startsWith('*** Update File:')) {
      const fPath = rowTrim.slice(16).trim();
      const updateLineNum = cursor + 1;
      cursor++;
      let movePath: string | undefined;
      while (cursor < lastValid && sourceLines[cursor].trim() === '') cursor++;
      if (cursor < lastValid && sourceLines[cursor].trim().startsWith('*** Move to:')) {
        movePath = sourceLines[cursor].trim().slice(12).trim();
        cursor++;
      }
      const chunks: { anchor?: string; o: string[]; n: string[]; isEof?: boolean; body?: { type: string; text: string }[] }[] = [];
      while (cursor < lastValid) {
        if (sourceLines[cursor].trim() === '') { cursor++; continue; }
        if (sourceLines[cursor].trim().startsWith('***')) break;
        let anchorText: string | undefined;
        if (sourceLines[cursor].trim().startsWith('@@')) {
          anchorText = sourceLines[cursor].trim().slice(2).trim();
          cursor++;
        }
        const chunkBodyRows: { type: string; text: string }[] = [];
        let reachesEof = false;
        while (cursor < lastValid) {
          const bodyLine = sourceLines[cursor];
          const bodyTrim = bodyLine.trim();
          if (bodyTrim === '' || bodyTrim.startsWith('@@') || bodyTrim.startsWith('*** End of File') || bodyTrim.startsWith('***')) {
            if (bodyTrim.startsWith('*** End of File')) { reachesEof = true; cursor++; }
            break;
          }
          if (bodyLine.startsWith(' ') || bodyLine.startsWith('-') || bodyLine.startsWith('+')) {
            chunkBodyRows.push({ type: bodyLine[0], text: bodyLine.slice(1) });
            cursor++;
          } else if (bodyLine === '') {
            chunkBodyRows.push({ type: ' ', text: '' });
            cursor++;
          } else {
            break;
          }
        }
        while (chunkBodyRows.length > 0 && chunkBodyRows[chunkBodyRows.length - 1].type === ' ' && chunkBodyRows[chunkBodyRows.length - 1].text === '') {
          chunkBodyRows.pop();
        }
        if (!anchorText && chunkBodyRows.length === 0 && !reachesEof) {
          if (chunks.length === 0 && !movePath) return { ops: [], error: { line: updateLineNum } };
          break;
        }
        let oldSeq: string[] = [], newSeq: string[] = [];
        for (const item of chunkBodyRows) {
          if (item.type === ' ') { oldSeq.push(item.text); newSeq.push(item.text); }
          else if (item.type === '-') { oldSeq.push(item.text); }
          else if (item.type === '+') { newSeq.push(item.text); }
        }
        chunks.push({ anchor: anchorText, o: oldSeq, n: newSeq, isEof: reachesEof, body: chunkBodyRows });
        if (reachesEof) break;
      }
      collectedOps.push({ type: movePath ? 'rename' : 'update', path: fPath, newPath: movePath, chunks });
    } else return { ops: [], error: { line: cursor + 1 } };
  }
  return { ops: collectedOps };
}

function parseJsonEdits(patchText: string): { ops: EditOp[]; error?: { line: number } } {
  const stripped = patchText.trim();
  const sourceLines = patchText.split('\n');
  if (stripped.startsWith('[')) {
    let startingLine = 1;
    for (let idx = 0; idx < sourceLines.length; idx++) {
      if (sourceLines[idx].trim().startsWith('[')) { startingLine = idx + 1; break; }
    }
    let parsedArray: any;
    try { parsedArray = JSON.parse(patchText); } catch (e) { return { ops: [], error: { line: startingLine } }; }
    if (!Array.isArray(parsedArray)) return { ops: [], error: { line: startingLine } };
    const collectedOps: EditOp[] = [];
    for (const elem of parsedArray) {
      if (!elem || typeof elem !== 'object' || Array.isArray(elem)) return { ops: [], error: { line: startingLine } };
      const actionCmd = elem.command, targetP = elem.path;
      if (!targetP || typeof targetP !== 'string') return { ops: [], error: { line: startingLine } };
      if (actionCmd === 'create' && typeof elem.file_text === 'string') {
        collectedOps.push({ type: 'create', path: targetP, fileText: elem.file_text });
      } else if (actionCmd === 'str_replace' && typeof elem.old_str === 'string' && elem.old_str !== '' && (elem.new_str === undefined || typeof elem.new_str === 'string')) {
        collectedOps.push({ type: 'update', path: targetP, oldStr: elem.old_str, newStr: elem.new_str || '' });
      } else if (actionCmd === 'insert' && Number.isInteger(elem.insert_line) && typeof elem.new_str === 'string') {
        collectedOps.push({ type: 'update', path: targetP, insertLine: elem.insert_line, newStr: elem.new_str });
      } else {
        return { ops: [], error: { line: startingLine } };
      }
    }
    return { ops: collectedOps };
  } else {
    const collectedOps: EditOp[] = [];
    for (let idx = 0; idx < sourceLines.length; idx++) {
      const currentLine = sourceLines[idx].replace(/\r$/, '');
      if (currentLine.trim() === '') continue;
      let singleObj: any;
      try { singleObj = JSON.parse(currentLine); } catch (e) { return { ops: [], error: { line: idx + 1 } }; }
      if (!singleObj || typeof singleObj !== 'object' || Array.isArray(singleObj)) return { ops: [], error: { line: idx + 1 } };
      const actionCmd = singleObj.command, targetP = singleObj.path;
      if (!targetP || typeof targetP !== 'string') return { ops: [], error: { line: idx + 1 } };
      if (actionCmd === 'create' && typeof singleObj.file_text === 'string') {
        collectedOps.push({ type: 'create', path: targetP, fileText: singleObj.file_text });
      } else if (actionCmd === 'str_replace' && typeof singleObj.old_str === 'string' && singleObj.old_str !== '' && (singleObj.new_str === undefined || typeof singleObj.new_str === 'string')) {
        collectedOps.push({ type: 'update', path: targetP, oldStr: singleObj.old_str, newStr: singleObj.new_str || '' });
      } else if (actionCmd === 'insert' && Number.isInteger(singleObj.insert_line) && typeof singleObj.new_str === 'string') {
        collectedOps.push({ type: 'update', path: targetP, insertLine: singleObj.insert_line, newStr: singleObj.new_str });
      } else {
        return { ops: [], error: { line: idx + 1 } };
      }
    }
    return { ops: collectedOps };
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
  const repositoryFiles = new Map<string, string>();
  function populateTree(currentDir: string, relativeBase: string) {
    if (!fs.existsSync(currentDir)) return;
    for (const directoryEntry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (directoryEntry.name === '.git' || directoryEntry.name === '.makefun') continue;
      const relPath = relativeBase ? `${relativeBase}/${directoryEntry.name}` : directoryEntry.name;
      const fullPath = path.join(currentDir, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        populateTree(fullPath, relPath);
      } else if (directoryEntry.isFile()) {
        try {
          repositoryFiles.set(relPath, fs.readFileSync(fullPath, 'utf8'));
        } catch (err) {}
      }
    }
  }
  populateTree('.', '');

  const modifiedChanges = new Map<string, any>();
  const reportedErrors: string[] = [];

  for (const singleOp of ops) {
    if (!isSafePath(singleOp.path)) {
      reportedErrors.push(`unsafe ${singleOp.path}`);
      continue;
    }
    if (singleOp.newPath && !isSafePath(singleOp.newPath)) {
      reportedErrors.push(`unsafe ${singleOp.newPath}`);
      continue;
    }

    if (singleOp.type === 'create') {
      if (repositoryFiles.has(singleOp.path)) {
        reportedErrors.push(`exists ${singleOp.path}`);
        continue;
      }
      let generatedContent = singleOp.fileText ?? (
        singleOp.content ? singleOp.content.join('\n') + (singleOp.content.length > 0 ? '\n' : '') : (
          singleOp.hunks ? singleOp.hunks.map(h => h.n.join('\n') + (h.hasEol && h.n.length > 0 ? '\n' : '')).join('') : ''
        )
      );
      repositoryFiles.set(singleOp.path, generatedContent);
      modifiedChanges.set(singleOp.path, { type: 'A', content: generatedContent });
    } else if (singleOp.type === 'delete') {
      if (!repositoryFiles.has(singleOp.path)) {
        reportedErrors.push(`missing ${singleOp.path}`);
        continue;
      }
      repositoryFiles.delete(singleOp.path);
      modifiedChanges.set(singleOp.path, { type: 'D' });
    } else if (singleOp.type === 'rename') {
      if (!repositoryFiles.has(singleOp.path)) {
        reportedErrors.push(`missing ${singleOp.path}`);
        continue;
      }
      if (repositoryFiles.has(singleOp.newPath!)) {
        reportedErrors.push(`exists ${singleOp.newPath!}`);
        continue;
      }
      let filePayload = repositoryFiles.get(singleOp.path)!;
      if (singleOp.hunks && singleOp.hunks.length > 0) {
        const outcome = applyHunks(filePayload, singleOp.hunks, strict);
        if (!outcome.ok) {
          reportedErrors.push(`${outcome.reason} ${singleOp.path}`);
          continue;
        }
        filePayload = outcome.content;
      } else if (singleOp.chunks && singleOp.chunks.length > 0) {
        const outcome = applyChunks(filePayload, singleOp.chunks, strict);
        if (!outcome.ok) {
          reportedErrors.push(`${outcome.reason} ${singleOp.path}`);
          continue;
        }
        filePayload = outcome.content;
      }
      repositoryFiles.delete(singleOp.path);
      repositoryFiles.set(singleOp.newPath!, filePayload);
      modifiedChanges.set(singleOp.newPath!, { type: 'R', oldPath: singleOp.path, newPath: singleOp.newPath, content: filePayload });
      modifiedChanges.delete(singleOp.path);
    } else if (singleOp.type === 'update') {
      if (!repositoryFiles.has(singleOp.path)) {
        reportedErrors.push(`missing ${singleOp.path}`);
        continue;
      }
      let filePayload = repositoryFiles.get(singleOp.path)!;

      if (singleOp.oldStr !== undefined) {
        const isWindowsCrLf = filePayload.includes('\r\n');
        let normalizedText = isWindowsCrLf ? filePayload.replace(/\r\n/g, '\n') : filePayload;
        const normalizedOld = singleOp.oldStr.replace(/\r\n/g, '\n');
        const normalizedNew = singleOp.newStr!.replace(/\r\n/g, '\n');
        let matchCount = 0, searchIndex = normalizedText.indexOf(normalizedOld);
        while (searchIndex !== -1) {
          matchCount++;
          searchIndex = normalizedText.indexOf(normalizedOld, searchIndex + 1);
        }
        if (matchCount === 0) {
          reportedErrors.push(`no-match ${singleOp.path}`);
          continue;
        }
        if (matchCount > 1) {
          reportedErrors.push(`ambiguous ${singleOp.path}`);
          continue;
        }
        normalizedText = normalizedText.replace(normalizedOld, normalizedNew);
        filePayload = isWindowsCrLf ? normalizedText.replace(/\n/g, '\r\n') : normalizedText;
        repositoryFiles.set(singleOp.path, filePayload);
        modifiedChanges.set(singleOp.path, { type: 'M', content: filePayload });
      } else if (singleOp.insertLine !== undefined) {
        const parsedDoc = parseFile(filePayload);
        if (singleOp.insertLine < 0 || singleOp.insertLine > parsedDoc.lines.length) {
          reportedErrors.push(`no-match ${singleOp.path}`);
          continue;
        }
        const insertRows = singleOp.newStr.split('\n').map(l => l.replace(/\r$/, ''));
        if (singleOp.newStr.endsWith('\n') && insertRows.length > 0 && insertRows[insertRows.length - 1] === '') {
          insertRows.pop();
        }
        if (singleOp.newStr === '') {
          insertRows.length = 0;
        }
        parsedDoc.lines.splice(singleOp.insertLine, 0, ...insertRows);
        filePayload = serializeFile(parsedDoc);
        repositoryFiles.set(singleOp.path, filePayload);
        modifiedChanges.set(singleOp.path, { type: 'M', content: filePayload });
      } else if (singleOp.chunks) {
        const parsedDoc = parseFile(filePayload);
        let currentOffset = 0, hasFailed = false, failReasonTag = '';
        for (const itemChunk of singleOp.chunks) {
          if (itemChunk.isEof) {
            if (itemChunk.anchor) {
              const matchesGrade0 = locateGrade0(parsedDoc.lines, [itemChunk.anchor]);
              let matchedIndex = -1;
              for (const idxVal of matchesGrade0) {
                if (idxVal + 1 === parsedDoc.lines.length) { matchedIndex = idxVal; break; }
              }
              if (matchedIndex === -1) {
                const matchesGrade1 = locateGrade1(parsedDoc.lines, [itemChunk.anchor]);
                for (const idxVal of matchesGrade1) {
                  if (idxVal + 1 === parsedDoc.lines.length) { matchedIndex = idxVal; break; }
                }
              }
              if (matchedIndex === -1) {
                const matchesGrade2 = locateGrade2(parsedDoc.lines, [itemChunk.anchor]);
                for (const idxVal of matchesGrade2) {
                  if (idxVal + 1 === parsedDoc.lines.length) { matchedIndex = idxVal; break; }
                }
              }
              if (matchedIndex === -1) {
                hasFailed = true;
                failReasonTag = 'no-match';
                break;
              }
              currentOffset = matchedIndex;
            } else {
              let eofMatchIndex = -1, eofMatchTier = 0;
              for (const tierLevel of (strict ? [0] : [0, 1, 2])) {
                const lookupFn = tierLevel === 0 ? locateGrade0 : tierLevel === 1 ? locateGrade1 : locateGrade2;
                const foundIndices = lookupFn(parsedDoc.lines, itemChunk.o);
                for (const idxVal of foundIndices) {
                  if (idxVal + itemChunk.o.length === parsedDoc.lines.length) {
                    eofMatchIndex = idxVal;
                    eofMatchTier = tierLevel;
                    break;
                  }
                }
                if (eofMatchIndex !== -1) break;
              }
              if (eofMatchIndex === -1) {
                hasFailed = true;
                failReasonTag = 'no-match';
                break;
              }
              const replacementLines = buildReplacement(itemChunk, parsedDoc.lines.slice(eofMatchIndex, eofMatchIndex + itemChunk.o.length), eofMatchTier);
              parsedDoc.lines.splice(eofMatchIndex, itemChunk.o.length, ...replacementLines);
              currentOffset = eofMatchIndex + replacementLines.length;
              continue;
            }
          }

          if (itemChunk.anchor) {
            let locatedAnchor: { index: number; tier: number } | null = null;
            for (const tierLevel of (strict ? [0] : [0, 1, 2])) {
              const lookupFn = tierLevel === 0 ? locateGrade0 : tierLevel === 1 ? locateGrade1 : locateGrade2;
              const subMatches = lookupFn(parsedDoc.lines.slice(currentOffset), [itemChunk.anchor]);
              if (subMatches.length > 0) {
                locatedAnchor = { index: currentOffset + subMatches[0], tier: tierLevel };
                break;
              }
            }
            if (!locatedAnchor) {
              hasFailed = true;
              failReasonTag = 'no-match';
              break;
            }
            currentOffset = locatedAnchor.index + 1;
          }

          if (itemChunk.o.length > 0) {
            const occurrenceInfo = locateInstance(parsedDoc.lines.slice(currentOffset), itemChunk.o, strict);
            if (!occurrenceInfo) {
              hasFailed = true;
              failReasonTag = 'no-match';
              break;
            }
            const absoluteLoc = currentOffset + occurrenceInfo.index;
            const replacementLines = buildReplacement(itemChunk, parsedDoc.lines.slice(absoluteLoc, absoluteLoc + itemChunk.o.length), occurrenceInfo.tier);
            parsedDoc.lines.splice(absoluteLoc, itemChunk.o.length, ...replacementLines);
            currentOffset = absoluteLoc + replacementLines.length;
          } else {
            parsedDoc.lines.splice(currentOffset, 0, ...itemChunk.n);
            currentOffset += itemChunk.n.length;
          }
        }

        if (hasFailed) {
          reportedErrors.push(`${failReasonTag} ${singleOp.path}`);
          continue;
        }
        filePayload = serializeFile(parsedDoc);
        repositoryFiles.set(singleOp.path, filePayload);
        modifiedChanges.set(singleOp.path, { type: 'M', content: filePayload });
      } else if (singleOp.hunks) {
        const parsedDoc = parseFile(filePayload);
        let cumulativeDelta = 0, hasFailed = false, failReasonTag = '';
        for (const itemHunk of singleOp.hunks) {
          const cleanOldLines = itemHunk.o;
          const cleanNewLines = itemHunk.n;

          if (cleanOldLines.length === 0) {
            const insertionIndex = Math.min(parsedDoc.lines.length, (itemHunk.a ?? 0) + cumulativeDelta);
            parsedDoc.lines.splice(insertionIndex, 0, ...cleanNewLines);
            if (!itemHunk.hasEol) parsedDoc.hasEol = false;
            cumulativeDelta += cleanNewLines.length - cleanOldLines.length;
          } else {
            let matchedList: { index: number; tier: number }[] = [];
            const selectLookup = (t: number) => t === 0 ? locateGrade0 : t === 1 ? locateGrade1 : locateGrade2;
            for (const tierLevel of (strict ? [0] : [0, 1, 2])) {
              const resArr = selectLookup(tierLevel)(parsedDoc.lines, cleanOldLines);
              if (resArr.length > 0) {
                matchedList = resArr.map(idxVal => ({ index: idxVal, tier: tierLevel }));
                break;
              }
            }
            if (matchedList.length === 0) {
              hasFailed = true;
              failReasonTag = 'no-match';
              break;
            }
            const isSearchReplaceBlock = itemHunk.a === undefined;
            if (isSearchReplaceBlock && matchedList.length > 1) {
              const firstTierLevel = matchedList[0].tier;
              const sameTierList = matchedList.filter(m => m.tier === firstTierLevel);
              if (sameTierList.length > 1) {
                hasFailed = true;
                failReasonTag = 'ambiguous';
                break;
              }
              matchedList = [sameTierList[0]];
            }
            let chosenMatch = matchedList[0];
            if (itemHunk.a !== undefined) {
              const expectedAnchorPos = itemHunk.a - 1 + cumulativeDelta;
              let shortestDist = Math.abs(chosenMatch.index - expectedAnchorPos);
              for (let idxVal = 1; idxVal < matchedList.length; idxVal++) {
                const calculatedDist = Math.abs(matchedList[idxVal].index - expectedAnchorPos);
                if (calculatedDist < shortestDist) {
                  shortestDist = calculatedDist;
                  chosenMatch = matchedList[idxVal];
                }
              }
            }
            const replacementLines = buildReplacement(itemHunk, parsedDoc.lines.slice(chosenMatch.index, chosenMatch.index + cleanOldLines.length), chosenMatch.tier);
            parsedDoc.lines.splice(chosenMatch.index, cleanOldLines.length, ...replacementLines);
            if (!itemHunk.hasEol) parsedDoc.hasEol = false;
            cumulativeDelta += replacementLines.length - cleanOldLines.length;
          }
        }
        if (hasFailed) {
          reportedErrors.push(`${failReasonTag || 'no-match'} ${singleOp.path}`);
          continue;
        }
        filePayload = serializeFile(parsedDoc);
        repositoryFiles.set(singleOp.path, filePayload);
        modifiedChanges.set(singleOp.path, { type: 'M', content: filePayload });
      }
    }
  }
  return { success: reportedErrors.length === 0, fileChanges: modifiedChanges, errorLines: reportedErrors };
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
