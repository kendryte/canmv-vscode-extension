const STARTUP_SCRIPT_PATHS = new Set([
  '/sdcard/boot.py',
  '/sdcard/main.py',
]);

const STRING_PREFIXES = ['br', 'rb', 'fr', 'rf', 'r', 'u', 'b', 'f'];

export function minifyStartupScript(remotePath: string, data: Uint8Array, enabled = true): Uint8Array {
  if (!enabled || !isStartupScriptPath(remotePath)) return data;

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    // File writes can contain arbitrary binary data; do not alter invalid UTF-8.
    return data;
  }
  return new TextEncoder().encode(minifyPythonSource(source));
}

export function minifyPythonSource(source: string): string {
  const lines: string[] = [];
  let line = '';
  let outsideStringLine = '';
  let quote: '"' | "'" | undefined;
  let tripleQuoted = false;
  let bracketDepth = 0;
  let logicalLineStart = true;
  let physicalLineStart = true;

  for (let index = 0; index < source.length;) {
    const newlineLength = newlineLengthAt(source, index);
    if (newlineLength > 0) {
      const inTripleQuotedString = quote !== undefined && tripleQuoted;
      appendLine(lines, line, inTripleQuotedString);
      logicalLineStart = !quote && bracketDepth === 0 && !endsWithExplicitContinuation(outsideStringLine);
      line = '';
      outsideStringLine = '';
      physicalLineStart = true;
      index += newlineLength;
      continue;
    }

    const char = source[index];
    if (!quote && physicalLineStart && logicalLineStart) {
      if (isLineWhitespace(char)) {
        line += char;
        outsideStringLine += char;
        index++;
        continue;
      }
      const standaloneBlockEnd = standaloneTripleQuotedBlockEnd(source, index);
      if (standaloneBlockEnd !== undefined) {
        line = '';
        outsideStringLine = '';
        physicalLineStart = true;
        logicalLineStart = true;
        index = standaloneBlockEnd;
        continue;
      }
    }

    if (quote) {
      if (tripleQuoted && source.startsWith(quote.repeat(3), index)) {
        line += quote.repeat(3);
        index += 3;
        quote = undefined;
        tripleQuoted = false;
      } else {
        line += char;
        if (char === '\\' && index + 1 < source.length && newlineLengthAt(source, index + 1) === 0) {
          line += source[index + 1];
          index += 2;
        } else {
          index++;
          if (!tripleQuoted && char === quote) {
            quote = undefined;
          }
        }
      }
      physicalLineStart = false;
      continue;
    }

    if (char === '#') {
      line = trimLineWhitespace(line);
      outsideStringLine = trimLineWhitespace(outsideStringLine);
      index++;
      while (index < source.length && newlineLengthAt(source, index) === 0) {
        index++;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tripleQuoted = source.startsWith(char.repeat(3), index);
      if (tripleQuoted) {
        line += char.repeat(3);
        index += 3;
      } else {
        line += char;
        index++;
      }
      physicalLineStart = false;
      continue;
    }

    line += char;
    outsideStringLine += char;
    if (char === '(' || char === '[' || char === '{') {
      bracketDepth++;
    } else if ((char === ')' || char === ']' || char === '}') && bracketDepth > 0) {
      bracketDepth--;
    }
    if (!isLineWhitespace(char)) {
      physicalLineStart = false;
    }
    index++;
  }

  appendLine(lines, line, quote !== undefined && tripleQuoted);
  return lines.join('\n');
}

function appendLine(lines: string[], line: string, preserveTrailingWhitespace: boolean): void {
  const minifiedLine = preserveTrailingWhitespace ? line : trimLineWhitespace(line);
  if (minifiedLine.length > 0 || preserveTrailingWhitespace) {
    lines.push(minifiedLine);
  }
}

function standaloneTripleQuotedBlockEnd(source: string, index: number): number | undefined {
  const triple = tripleQuoteAt(source, index);
  if (!triple) return undefined;

  const end = tripleQuoteEnd(source, triple.contentStart, triple.delimiter);
  if (end === undefined) return undefined;

  let lineEnd = end;
  while (lineEnd < source.length && newlineLengthAt(source, lineEnd) === 0) {
    lineEnd++;
  }
  const suffix = source.slice(end, lineEnd);
  if (!/^[ \t\f]*(?:#.*)?$/.test(suffix)) return undefined;

  return lineEnd + newlineLengthAt(source, lineEnd);
}

function tripleQuoteAt(source: string, index: number): { delimiter: string; contentStart: number } | undefined {
  for (const prefix of ['', ...STRING_PREFIXES]) {
    const quoteIndex = index + prefix.length;
    if (prefix && source.slice(index, quoteIndex).toLowerCase() !== prefix) continue;
    const quote = source[quoteIndex];
    if ((quote === '"' || quote === "'") && source.startsWith(quote.repeat(3), quoteIndex)) {
      return { delimiter: quote.repeat(3), contentStart: quoteIndex + 3 };
    }
  }
  return undefined;
}

function tripleQuoteEnd(source: string, index: number, delimiter: string): number | undefined {
  for (let cursor = index; cursor < source.length;) {
    if (source[cursor] === '\\' && cursor + 1 < source.length) {
      cursor += newlineLengthAt(source, cursor + 1) === 0 ? 2 : 1;
      continue;
    }
    if (source.startsWith(delimiter, cursor)) {
      return cursor + delimiter.length;
    }
    cursor++;
  }
  return undefined;
}

function endsWithExplicitContinuation(line: string): boolean {
  const trimmed = trimLineWhitespace(line);
  let slashCount = 0;
  for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === '\\'; index--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function trimLineWhitespace(value: string): string {
  return value.replace(/[ \t\f]+$/g, '');
}

function isLineWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\f';
}

function newlineLengthAt(source: string, index: number): number {
  if (source[index] === '\r') return source[index + 1] === '\n' ? 2 : 1;
  return source[index] === '\n' ? 1 : 0;
}

export function isStartupScriptPath(remotePath: string): boolean {
  const normalized = '/' + remotePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
  return STARTUP_SCRIPT_PATHS.has(normalized);
}
