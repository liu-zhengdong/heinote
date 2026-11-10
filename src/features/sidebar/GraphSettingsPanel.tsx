import { ChevronRight, Plus, RotateCcw, Search, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { COLOR_NAMES } from "../../../schema";
import { DEFAULT_GRAPH_SETTINGS, GRAPH_RANGES, MAX_GROUPS, MAX_QUERY, type GraphNumber } from "../../core/graph-settings";
import type { ColorName, GraphSettings } from "../../core/types";

type Section = keyof GraphSettings["open"];

/** A section of the panel: its title, pressed to open or close it. */
function Part({
  section,
  title,
  open,
  onToggle,
  actions,
  children,
}: {
  section: Section;
  title: string;
  open: boolean;
  onToggle(section: Section): void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`graph-settings__part ${open ? "is-open" : ""}`} data-section={section}>
      <div className="graph-settings__head">
        <button
          type="button"
          className="graph-settings__title"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => onToggle(section)}
        >
          <ChevronRight size={12} className="graph-settings__chevron" aria-hidden="true" />
          {title}
        </button>
        {actions}
      </div>
      {open ? <div id={id} className="graph-settings__body">{children}</div> : null}
    </div>
  );
}

/** A setting that is on or off — Notion's switch. */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange(next: boolean): void }) {
  return (
    <label className="graph-settings__row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? "is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__knob" />
      </button>
    </label>
  );
}

/** A number, dragged, on one line: its name, the slider, what it is now.
 *  `short` is the name drawn where the full one (Obsidian's, kept as the
 *  slider's label and the name's tooltip) would not fit the line. */
function Slider({
  label,
  short,
  name,
  value,
  onChange,
}: {
  label: string;
  short?: string;
  name: GraphNumber;
  value: number;
  onChange(next: number): void;
}) {
  const { min, max, step } = GRAPH_RANGES[name];
  // As many decimals as the slider moves in: 250, 10.0, 0.50.
  const shown = value.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  return (
    <label className="graph-settings__slider">
      <span className="graph-settings__name" title={label}>{short ?? label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ ["--slider-fill" as string]: `${((value - min) / (max - min)) * 100}%` }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="graph-settings__value">{shown}</span>
    </label>
  );
}

/** A group's colour, chosen from Notion's nine. */
function GroupColor({ color, label, onChange }: { color: ColorName; label: string; onChange(next: ColorName): void }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  return (
    <>
      <button
        type="button"
        className="graph-group__color"
        data-tone={color}
        aria-label={`${label}: ${color}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(anchor ? null : rectOf(event.currentTarget))}
      />
      <Popover open={Boolean(anchor)} anchor={anchor} placement="bottom-start" role="dialog" label="Group colour" onDismiss={() => setAnchor(null)}>
        <div className="graph-group__colors">
          {COLOR_NAMES.map((choice) => (
            <button
              type="button"
              key={choice}
              className={`graph-group__swatch ${choice === color ? "is-selected" : ""}`}
              data-tone={choice}
              aria-label={choice}
              aria-pressed={choice === color}
              onClick={() => {
                onChange(choice);
                setAnchor(null);
              }}
            />
          ))}
        </div>
      </Popover>
    </>
  );
}

/** Obsidian's graph settings, as a card over the graph: Filters (a search,
 *  database rows, pages joined to nothing, and — around a page — how far),
 *  Groups (pages a query finds, in a colour), Display (arrows, when names
 *  show, dot and line size, and Animate) and Forces (the layout's four).
 *  Every change is drawn as it is made; ↺ puts every setting back. */
export function GraphSettingsPanel({
  settings,
  local,
  onChange,
  onAnimate,
  onClose,
}: {
  settings: GraphSettings;
  /** Around a page: the depth is offered. */
  local: boolean;
  onChange(next: GraphSettings): void;
  onAnimate(): void;
  onClose(): void;
}) {
  const set = <K extends keyof GraphSettings>(key: K, value: GraphSettings[K]) => onChange({ ...settings, [key]: value });
  const toggle = (section: Section) => set("open", { ...settings.open, [section]: !settings.open[section] });
  const setGroup = (index: number, patch: Partial<GraphSettings["groups"][number]>) =>
    set("groups", settings.groups.map((group, at) => (at === index ? { ...group, ...patch } : group)));
  // A new group takes the next colour no group wears yet.
  const nextColor = COLOR_NAMES.find((color) => !settings.groups.some((group) => group.color === color)) ?? "gray";

  return (
    <section className="graph-settings" aria-label="Graph settings">
      <Part
        section="filters"
        title="Filters"
        open={settings.open.filters}
        onToggle={toggle}
        actions={(
          <span className="graph-settings__actions">
            <Tooltip label="Restore default settings">
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label="Restore default settings"
                onClick={() => onChange({ ...DEFAULT_GRAPH_SETTINGS, open: settings.open })}
              >
                <RotateCcw size={13} />
              </button>
            </Tooltip>
            <Tooltip label="Close">
              <button type="button" className="icon-btn icon-btn--sm" aria-label="Close graph settings" onClick={onClose}>
                <X size={14} />
              </button>
            </Tooltip>
          </span>
        )}
      >
        <label className="graph-settings__search">
          <Search size={13} aria-hidden="true" />
          <input
            value={settings.search}
            maxLength={MAX_QUERY}
            placeholder="Search pages…"
            aria-label="Search pages"
            spellCheck={false}
            onChange={(event) => set("search", event.target.value)}
          />
          {settings.search ? (
            <button type="button" className="graph-settings__clear" aria-label="Clear search" onClick={() => set("search", "")}>
              <X size={10} />
            </button>
          ) : null}
        </label>
        {local ? <Slider label="Depth" name="depth" value={settings.depth} onChange={(value) => set("depth", value)} /> : null}
        <Switch label="Database rows" checked={settings.rows} onChange={(value) => set("rows", value)} />
        <Switch label="Orphans" checked={settings.orphans} onChange={(value) => set("orphans", value)} />
      </Part>

      <Part section="groups" title="Groups" open={settings.open.groups} onToggle={toggle}>
        {settings.groups.map((group, index) => (
          <div key={index} className="graph-group">
            <GroupColor color={group.color} label={`Group ${index + 1} colour`} onChange={(color) => setGroup(index, { color })} />
            <input
              className="graph-group__query"
              value={group.query}
              maxLength={MAX_QUERY}
              placeholder="Enter query…"
              aria-label={`Group ${index + 1} query`}
              spellCheck={false}
              onChange={(event) => setGroup(index, { query: event.target.value })}
            />
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={`Delete group ${index + 1}`}
              onClick={() => set("groups", settings.groups.filter((_, at) => at !== index))}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {settings.groups.length < MAX_GROUPS ? (
          <button
            type="button"
            className="btn graph-settings__button"
            onClick={() => set("groups", [...settings.groups, { query: "", color: nextColor }])}
          >
            <Plus size={12} />New group
          </button>
        ) : null}
      </Part>

      <Part section="display" title="Display" open={settings.open.display} onToggle={toggle}>
        <Switch label="Arrows" checked={settings.arrows} onChange={(value) => set("arrows", value)} />
        <Slider label="Text fade threshold" short="Text fade" name="text_fade" value={settings.text_fade} onChange={(value) => set("text_fade", value)} />
        <Slider label="Node size" name="node_size" value={settings.node_size} onChange={(value) => set("node_size", value)} />
        <Slider label="Link thickness" name="link_thickness" value={settings.link_thickness} onChange={(value) => set("link_thickness", value)} />
        <button type="button" className="btn graph-settings__button graph-settings__animate" onClick={onAnimate}>Animate</button>
      </Part>

      <Part section="forces" title="Forces" open={settings.open.forces} onToggle={toggle}>
        <Slider label="Center force" name="center_force" value={settings.center_force} onChange={(value) => set("center_force", value)} />
        <Slider label="Repel force" name="repel_force" value={settings.repel_force} onChange={(value) => set("repel_force", value)} />
        <Slider label="Link force" name="link_force" value={settings.link_force} onChange={(value) => set("link_force", value)} />
        <Slider label="Link distance" name="link_distance" value={settings.link_distance} onChange={(value) => set("link_distance", value)} />
      </Part>
    </section>
  );
}
