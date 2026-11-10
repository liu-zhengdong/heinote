/* The keys a code block keeps for itself, as plain-text edits: Enter starts a
   new line at the same indentation, Tab indents and Shift+Tab outdents. Each
   returns the new text and where the selection lands in it. */

export const CODE_INDENT = "  ";

export interface CodeEdit {
  text: string;
  start: number;
  end: number;
}

/** Enter: a newline, carrying the current line's indentation onto the next. */
export function codeNewline(text: string, start: number, end: number): CodeEdit {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, start))?.[0] ?? "";
  const inserted = `\n${indent}`;
  const caret = start + inserted.length;
  return { text: text.slice(0, start) + inserted + text.slice(end), start: caret, end: caret };
}

/** Tab with nothing selected types an indent. Otherwise every line the
 *  selection touches moves in (or, with Shift, out) by one indent — a line
 *  the selection only reaches the very start of is left alone. */
export function codeIndent(text: string, start: number, end: number, outdent: boolean): CodeEdit {
  if (!outdent && start === end) {
    const caret = start + CODE_INDENT.length;
    return { text: text.slice(0, start) + CODE_INDENT + text.slice(end), start: caret, end: caret };
  }
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const lineStarts = [text.lastIndexOf("\n", start - 1) + 1];
  for (let at = text.indexOf("\n", lineStarts[0]); at !== -1 && at < last; at = text.indexOf("\n", at + 1)) {
    lineStarts.push(at + 1);
  }
  let next = text;
  let from = start;
  let to = end;
  // Last line first, so each edit leaves the offsets before it untouched.
  for (const lineStart of lineStarts.reverse()) {
    if (outdent) {
      const removed = next.startsWith("\t", lineStart)
        ? 1
        : (/^ {1,2}/.exec(next.slice(lineStart, lineStart + CODE_INDENT.length))?.[0].length ?? 0);
      if (!removed) continue;
      next = next.slice(0, lineStart) + next.slice(lineStart + removed);
      const map = (offset: number) => (offset <= lineStart ? offset : Math.max(lineStart, offset - removed));
      from = map(from);
      to = map(to);
    } else {
      next = next.slice(0, lineStart) + CODE_INDENT + next.slice(lineStart);
      // A selection that starts at the very start of a line keeps the new
      // indent inside it, as editors do.
      if (from > lineStart) from += CODE_INDENT.length;
      if (to >= lineStart) to += CODE_INDENT.length;
    }
  }
  return { text: next, start: from, end: to };
}
