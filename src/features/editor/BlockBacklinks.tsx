import { pageName } from "../../core/block-tree";
import { inlineReadableText, type DescribeMention } from "../../core/inline-content";
import type { NotePage } from "../../core/types";
import { MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { pageGlyph } from "./block-registry";
import type { BlockReference } from "./mentions";

/** The longest passage shown for one link. */
const PASSAGE_LIMIT = 120;

/** A page's backlinks — a block's too, a block being a page: each page that
 *  links to it, and the passage there that does. Choosing one opens it
 *  there. */
export function BlockBacklinks({
  anchor,
  name,
  references,
  pages,
  describe,
  onOpen,
  onClose,
}: {
  anchor: AnchorRect;
  /** What the block linked to is called. */
  name: string;
  references: readonly BlockReference[];
  pages: Record<string, NotePage>;
  describe: DescribeMention;
  onOpen(reference: BlockReference): void;
  onClose(): void;
}) {
  return (
    <Popover open anchor={anchor} placement="bottom-start" label="Backlinks" group="page-menu" onDismiss={onClose}>
      <MenuList label={`Backlinks to ${name}`} autoFocus className="block-backlinks">
        <div className="menu__section-title block-backlinks__title">
          {references.length} backlink{references.length === 1 ? "" : "s"} to {name}
        </div>
        {references.map((reference) => {
          const page = pages[reference.pageId];
          const paragraph = page?.block_tree.by_id[reference.paragraphId];
          if (!page || !paragraph) return null;
          const passage = inlineReadableText(paragraph.content, describe).replace(/\s+/g, " ").trim();
          return (
            <MenuItem
              key={`${reference.pageId}:${reference.paragraphId}`}
              icon={page.icon ? <span className="block-backlinks__icon">{page.icon}</span> : pageGlyph(page)}
              label={pageName(page, describe)}
              description={passage.length > PASSAGE_LIMIT ? `${passage.slice(0, PASSAGE_LIMIT - 1).trimEnd()}…` : passage}
              onSelect={() => { onClose(); onOpen(reference); }}
            />
          );
        })}
      </MenuList>
    </Popover>
  );
}
