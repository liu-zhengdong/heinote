import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Baseline,
  ChevronDown,
  Combine,
  KeyboardOff,
  Link2,
  Plus,
  Ungroup,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useActiveEditSurface } from "../../app/edit-surface";
import { BottomSheet } from "../../components/BottomSheet";
import { MenuItem, MenuList } from "../../components/Menu";
import type { BlockKind } from "../../core/types";
import { useFold } from "../../hooks/useFold";
import { blockDefinition } from "./block-registry";
import { ColorMenu } from "./ColorMenu";
import { linkHref, LinkForm } from "./FormatToolbar";
import { MARKS } from "./marks";

type EditSheet = "insert" | "turn" | "link" | "color" | null;

const INSERT_KINDS: readonly BlockKind[] = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "todo",
  "bullet",
  "numbered",
  "quote",
  "callout",
  "code",
  "divider",
  "table",
];

const TURN_INTO_KINDS: readonly BlockKind[] = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "todo",
  "bullet",
  "numbered",
  "quote",
  "callout",
  "code",
];

const QUICK_MARKS = MARKS.filter((item) => item.mark !== "underline");

/** Mobile (<560px) keyboard-top formatting and block bar driven by ActiveEditSurface. */
export function MobileEditBar() {
  const mobile = useFold();
  const surface = useActiveEditSurface();
  const [sheet, setSheet] = useState<EditSheet>(null);
  const [hrefDraft, setHrefDraft] = useState("");

  const activeKey = surface ? `${surface.surfaceId}:${surface.mode}:${surface.blockId ?? ""}` : "";
  useEffect(() => {
    setSheet(null);
  }, [activeKey]);

  const setSubOverlay = surface?.setSubOverlayOpen;
  const openSheet = (next: Exclude<EditSheet, null>) => {
    if (next === "link") setHrefDraft(surface?.link ?? "");
    setSubOverlay?.(true);
    setSheet(next);
  };

  const closeSheet = () => {
    setSheet(null);
    setSubOverlay?.(false);
  };

  if (!mobile || !surface || surface.mode === "title") return null;

  const isCell = surface.mode === "cell";
  const currentKindLabel = surface.blockKind ? blockDefinition(surface.blockKind).label : "Text";
  const alignH = surface.cellAlign?.h ?? "left";
  const alignV = surface.cellAlign?.v ?? "top";

  return (
    <>
      <div
        className="mobile-edit-bar"
        role="toolbar"
        aria-label={isCell ? "单元格编辑栏" : "正文编辑栏"}
        onMouseDown={(event) => event.preventDefault()}
      >
        <div className="mobile-edit-bar__strip scroller">
          {isCell ? (
            <>
              <div className="mobile-edit-bar__group">
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${alignH === "left" ? "is-on" : ""}`}
                  aria-label="Align left"
                  aria-pressed={alignH === "left"}
                  onClick={() => surface.alignCell?.("left", alignV)}
                >
                  <AlignLeft size={17} />
                </button>
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${alignH === "center" ? "is-on" : ""}`}
                  aria-label="Align center"
                  aria-pressed={alignH === "center"}
                  onClick={() => surface.alignCell?.("center", alignV)}
                >
                  <AlignCenter size={17} />
                </button>
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${alignH === "right" ? "is-on" : ""}`}
                  aria-label="Align right"
                  aria-pressed={alignH === "right"}
                  onClick={() => surface.alignCell?.("right", alignV)}
                >
                  <AlignRight size={17} />
                </button>
              </div>
              <div className="mobile-edit-bar__group">
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${alignV === "top" ? "is-on" : ""}`}
                  aria-label="Align top"
                  aria-pressed={alignV === "top"}
                  onClick={() => surface.alignCell?.(alignH, "top")}
                >
                  <AlignVerticalJustifyStart size={17} />
                </button>
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${alignV === "middle" ? "is-on" : ""}`}
                  aria-label="Align middle"
                  aria-pressed={alignV === "middle"}
                  onClick={() => surface.alignCell?.(alignH, "middle")}
                >
                  <AlignVerticalJustifyCenter size={17} />
                </button>
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${alignV === "bottom" ? "is-on" : ""}`}
                  aria-label="Align bottom"
                  aria-pressed={alignV === "bottom"}
                  onClick={() => surface.alignCell?.(alignH, "bottom")}
                >
                  <AlignVerticalJustifyEnd size={17} />
                </button>
              </div>
              <div className="mobile-edit-bar__group">
                <button
                  type="button"
                  className="mobile-edit-bar__btn"
                  aria-label="Merge cells"
                  disabled={!surface.canMergeCell}
                  onClick={() => surface.mergeCell?.()}
                >
                  <Combine size={17} />
                </button>
                <button
                  type="button"
                  className="mobile-edit-bar__btn"
                  aria-label="Split cells"
                  disabled={!surface.canSplitCell}
                  onClick={() => surface.splitCell?.()}
                >
                  <Ungroup size={17} />
                </button>
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${surface.color || surface.backgroundColor ? "is-on" : ""}`}
                  aria-label="Color"
                  onClick={() => openSheet("color")}
                >
                  <Baseline size={17} />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mobile-edit-bar__group">
                <button
                  type="button"
                  className="mobile-edit-bar__chip"
                  aria-label="插入块"
                  onClick={() => openSheet("insert")}
                >
                  <Plus size={15} />
                  <span>块</span>
                </button>
                <button
                  type="button"
                  className="mobile-edit-bar__chip"
                  aria-label="转换为"
                  onClick={() => openSheet("turn")}
                >
                  <span>{currentKindLabel}</span>
                  <ChevronDown size={13} />
                </button>
              </div>
              <div className="mobile-edit-bar__group">
                {QUICK_MARKS.map(({ mark, label, icon: Icon }) => {
                  const pressed = Boolean(surface.marks?.[mark]);
                  return (
                    <button
                      key={mark}
                      type="button"
                      className={`mobile-edit-bar__btn ${pressed ? "is-on" : ""}`}
                      aria-label={label}
                      aria-pressed={pressed}
                      onClick={() => surface.toggleMark?.(mark)}
                    >
                      <Icon size={17} />
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${surface.link ? "is-on" : ""}`}
                  aria-label="Link"
                  onClick={() => openSheet("link")}
                >
                  <Link2 size={17} />
                </button>
                <button
                  type="button"
                  className={`mobile-edit-bar__btn ${surface.color ? "is-on" : ""}`}
                  aria-label="Color"
                  onClick={() => openSheet("color")}
                >
                  <Baseline size={17} />
                </button>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          className="mobile-edit-bar__btn mobile-edit-bar__dismiss"
          aria-label="收起键盘"
          onClick={() => surface.done()}
        >
          <KeyboardOff size={17} />
        </button>
      </div>

      <BottomSheet
        open={sheet === "insert"}
        label="插入块"
        title="插入块"
        size="auto"
        className="pop--sheet"
        onClose={closeSheet}
      >
        <MenuList label="插入块">
          {INSERT_KINDS.map((kind) => {
            const def = blockDefinition(kind);
            const Icon = def.icon;
            return (
              <MenuItem
                key={kind}
                icon={<Icon size={16} />}
                label={def.label}
                onSelect={() => {
                  closeSheet();
                  surface.insertBlock?.(kind);
                }}
              />
            );
          })}
        </MenuList>
      </BottomSheet>

      <BottomSheet
        open={sheet === "turn"}
        label="转换为"
        title="转换为"
        size="auto"
        className="pop--sheet"
        onClose={closeSheet}
      >
        <MenuList label="转换为">
          {TURN_INTO_KINDS.map((kind) => {
            const def = blockDefinition(kind);
            const Icon = def.icon;
            return (
              <MenuItem
                key={kind}
                icon={<Icon size={16} />}
                label={def.label}
                selected={surface.blockKind === kind}
                onSelect={() => {
                  closeSheet();
                  surface.turnInto?.(kind);
                }}
              />
            );
          })}
        </MenuList>
      </BottomSheet>

      <BottomSheet
        open={sheet === "link"}
        label="链接"
        title="链接"
        size="auto"
        className="pop--sheet mobile-edit-sheet"
        onClose={closeSheet}
      >
        <div className="mobile-edit-sheet__pad">
          <LinkForm
            value={hrefDraft}
            linked={Boolean(surface.link)}
            onValue={setHrefDraft}
            onSubmit={() => {
              const target = linkHref(hrefDraft);
              closeSheet();
              surface.setLink?.(target);
            }}
            onRemove={() => {
              closeSheet();
              surface.setLink?.(undefined);
            }}
          />
        </div>
      </BottomSheet>

      <BottomSheet
        open={sheet === "color"}
        label="颜色"
        title={isCell ? "文字与单元格背景" : "文字与背景色"}
        size="auto"
        className="pop--sheet"
        onClose={closeSheet}
      >
        <ColorMenu
          current={surface.color}
          currentBackground={isCell ? surface.backgroundColor : undefined}
          backgroundLabel={isCell ? "Cell color" : "Background color"}
          autoFocus={false}
          onPick={(color, where) => {
            closeSheet();
            surface.setColor?.(color, where);
          }}
        />
      </BottomSheet>
    </>
  );
}
