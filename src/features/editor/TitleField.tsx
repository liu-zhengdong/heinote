import type { InlineContent } from "../../core/types";
import { NAME_GRAMMAR, RichField, type RichFieldProps } from "./RichField";

/* A page's name as it is typed: in the page's head, and in a table's, a
   list's or a card's row while it is renamed. Notion's names are words that
   can carry links, so this is one line of `contenteditable` rather than a
   text field — a `RichField` with the name's grammar: words and links, one
   line (the rules, and every way they can go wrong, head core/title.ts). */
export function TitleField(props: Omit<RichFieldProps, "grammar">) {
  return <RichField grammar={NAME_GRAMMAR} {...props} />;
}

/** A name drawn at rest — in a table's or a list's row, on a card: its words,
 *  the linked ones marked as links (`data-href`), which the place opens on a
 *  click through `linkedWordsAt`. */
export function NameWords({ content }: { content: InlineContent }) {
  return (
    <>
      {content.map((run, index) => (run.marks?.link ? (
        <span key={index} className="name-link" data-href={run.marks.link} title={run.marks.link}>{run.text}</span>
      ) : run.text))}
    </>
  );
}

/** The link of the linked words a click landed on, if it landed on some. */
export function linkedWordsAt(target: EventTarget | null): string | null {
  return (target as Element | null)?.closest?.<HTMLElement>(".name-link[data-href]")?.dataset.href ?? null;
}
