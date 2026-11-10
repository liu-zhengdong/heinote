import { MenuItem, MenuList } from "../../components/Menu";
import { COLOR_NAMES } from "../../../schema";
import { capitalized } from "../../core/title";
import type { ContentColor } from "../../core/types";

/** Notion's "A" swatch: the letter in a text colour, or on a background. */
function Swatch({ color }: { color?: ContentColor | "background" }) {
  return <span className="swatch" data-color={color === "background" ? undefined : color} data-kind={color === "background" || color?.endsWith("_background") ? "background" : "text"} aria-hidden="true">A</span>;
}

/** The colours Notion offers a block or a stretch of text: nine text colours
 *  and nine backgrounds, each with a way back to none. `autoFocus` is off for
 *  a menu that hangs off a text selection, which must keep its selection. */
export function ColorMenu({
  current,
  autoFocus = true,
  onPick,
}: {
  current?: ContentColor;
  autoFocus?: boolean;
  onPick(color: ContentColor | undefined): void;
}) {
  return (
    <MenuList label="Color" autoFocus={autoFocus}>
      <div className="menu__section-title">Text color</div>
      <MenuItem icon={<Swatch />} label="Default" selected={!current} onSelect={() => onPick(undefined)} />
      {COLOR_NAMES.map((name) => (
        <MenuItem key={name} icon={<Swatch color={name} />} label={capitalized(name)} selected={current === name} onSelect={() => onPick(name)} />
      ))}
      <div className="menu__section-title">Background color</div>
      <MenuItem icon={<Swatch color="background" />} label="Default background" onSelect={() => onPick(undefined)} />
      {COLOR_NAMES.map((name) => (
        <MenuItem
          key={`${name}_background`}
          icon={<Swatch color={`${name}_background`} />}
          label={`${capitalized(name)} background`}
          selected={current === `${name}_background`}
          onSelect={() => onPick(`${name}_background`)}
        />
      ))}
    </MenuList>
  );
}
