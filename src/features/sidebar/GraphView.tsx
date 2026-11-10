import { ArrowUpRight, LocateFixed, Maximize, Orbit, Settings2, Waypoints } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Tooltip } from "../../components/Tooltip";
import { useWorkspaceState } from "../../app/workspace-store";
import { groupColors } from "../../core/graph-settings";
import type { ColorName, WorkspaceState } from "../../core/types";
import { referenceIndex } from "../editor/mentions";
import {
  buildGraph,
  filterGraph,
  graphAnchor,
  graphShape,
  GraphSimulation,
  neighbourhood,
  neighbours,
  sameGraph,
  subgraph,
  type GraphEdge,
  type GraphForces,
  type GraphNode,
  type Point,
} from "./graph";
import { GraphSettingsPanel } from "./GraphSettingsPanel";
import { useGraphSettings } from "./useGraphSettings";

/* Obsidian's graph: every page — blocks and a database's rows among them —
   as a dot, what holds what and what links to what as lines. In the side
   panel, or as a page of its own in the page pane (opened from the panel,
   as a note opens there). Around this page (the panel's default, as
   Obsidian's local graph) or everything (the page's). It is alive as
   Obsidian's is: it moves as it settles, pages glide to their new places
   when it changes, a dot can be picked up and dragged while what it joins
   follows, and the zoom eases. Drag anywhere else to move the drawing,
   scroll or pinch to zoom, press a dot to open it. Its settings — Obsidian's
   filters, groups, display and forces — are the member's own, shared by
   the two places it is drawn. */

type Scope = "local" | "all";
type Variant = "sidebar" | "page";

/* Which of the two each place shows is the reader's, on this device, like
   which pages are open in the tree. */
const SCOPE_KEYS: Record<Variant, string> = { sidebar: "notes.sidebar.graph", page: "notes.page.graph" };
const SCOPE_DEFAULTS: Record<Variant, Scope> = { sidebar: "local", page: "all" };

function readScope(variant: Variant): Scope {
  try {
    const stored = window.localStorage.getItem(SCOPE_KEYS[variant]);
    return stored === "all" || stored === "local" ? stored : SCOPE_DEFAULTS[variant];
  } catch {
    return SCOPE_DEFAULTS[variant];
  }
}

function writeScope(variant: Variant, scope: Scope): void {
  try {
    window.localStorage.setItem(SCOPE_KEYS[variant], scope);
  } catch {
    // Not remembered: it opens on its default next time.
  }
}

const sameColors = (left: ReadonlyMap<string, ColorName>, right: ReadonlyMap<string, ColorName>) =>
  left.size === right.size && [...left].every(([id, color]) => right.get(id) === color);

/** Screen = layout × k + (x, y). */
interface View {
  k: number;
  x: number;
  y: number;
}

/** The view drawn, where it is heading, and whether the reader put it there
 *  (then it is not fitted again until what it shows changes). */
interface Camera {
  view: View;
  target: View;
  own: boolean;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Room kept round the drawing: a dot's name hangs below it. */
const MARGIN = 30;
/** Past this zoom every name shows — faded in over the quarter below it;
 *  under that only the ones that matter. */
const NAMES_AT = { local: 0.55, all: 1.1 };
const NAME_LIMIT = 22;
/** Simulation steps drawn per frame: it settles in a second or two, and a
 *  held dot's neighbours answer at once. */
const SETTLE_STEPS = 3;
const HELD_STEPS = 2;
/** How fast the view catches up with where it is heading, in ms. */
const EASE_MS = 90;

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

function fit(positions: ReadonlyMap<string, Point>, width: number, height: number): View {
  if (!positions.size || !width || !height) return { k: 1, x: width / 2, y: height / 2 };
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const point of positions.values()) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  // Never blown up past a comfortable size: two dots are not a poster.
  const k = clampZoom(Math.min(2.4, (width - MARGIN * 2) / Math.max(right - left, 1), (height - MARGIN * 2) / Math.max(bottom - top, 1)));
  return { k, x: width / 2 - ((left + right) / 2) * k, y: height / 2 - ((top + bottom) / 2) * k };
}

function zoomAt(view: View, factor: number, at: Point): View {
  const k = clampZoom(view.k * factor);
  const scale = k / view.k;
  return { k, x: at.x - (at.x - view.x) * scale, y: at.y - (at.y - view.y) * scale };
}

function arrived(view: View, target: View): boolean {
  return Math.abs(view.k - target.k) < target.k * 1e-3 && Math.abs(view.x - target.x) < 0.25 && Math.abs(view.y - target.y) < 0.25;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** How long Animate takes to grow the graph, and in how many steps. */
const GROW_STEPS = 40;
const GROW_STEP_MS = 90;

const shortened = (label: string) => (label.length > NAME_LIMIT ? `${label.slice(0, NAME_LIMIT - 1).trimEnd()}…` : label);
const edgeKey = (edge: GraphEdge) => `${edge.kind}:${edge.from}>${edge.to}`;

/** One ref callback per key for elements the frame loop moves, kept for the
 *  component's life, so a render does not detach and reattach them. */
function useElementRefs<E extends Element>(registry: MutableRefObject<Map<string, E>>): (key: string) => (element: E | null) => void {
  const callbacks = useRef(new Map<string, (element: E | null) => void>());
  return useCallback((key: string) => {
    let callback = callbacks.current.get(key);
    if (!callback) {
      callback = (element) => {
        if (element) registry.current.set(key, element);
        else registry.current.delete(key);
      };
      callbacks.current.set(key, callback);
    }
    return callback;
  }, [registry]);
}

export function GraphView({
  variant = "sidebar",
  selectedPageId,
  onOpenPage,
  onOpenAsPage,
}: {
  /** In the side panel, or as a page of its own. */
  variant?: Variant;
  selectedPageId: string | null;
  /** A dot pressed; `full` when ⌘/Ctrl was held. */
  onOpenPage(pageId: string, full: boolean): void;
  /** The panel's "Open as full page": the graph in the page pane. */
  onOpenAsPage?(): void;
}) {
  const [scope, setScope] = useState<Scope>(() => readScope(variant));
  const [settings, setSettings] = useGraphSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Animate: the order the dots come in, and how many have. */
  const [growth, setGrowth] = useState<{ order: string[]; count: number } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The dot being dragged. */
  const [held, setHeld] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  /* The graph as it stands, through its filters — redrawn when a dot or a
     line changes, not with every word written in a page. Around a page, the
     page itself always stays, whatever the filters say. */
  const anchor = useWorkspaceState((state) => graphAnchor(state.pages, selectedPageId));
  const local = scope === "local" && anchor !== null;
  const { search, rows, orphans, depth } = settings;
  const selectGraph = useCallback(
    (state: WorkspaceState) => filterGraph(buildGraph(state.pages, referenceIndex(state.pages)), state.pages, { search, rows, orphans }, local ? anchor : null),
    [anchor, local, orphans, rows, search],
  );
  const graph = useWorkspaceState(selectGraph, sameGraph);
  const shown = useMemo(() => (local && anchor ? neighbourhood(graph, [anchor], depth) : graph), [anchor, depth, graph, local]);
  /* Animate grows the graph in the order its pages were made; while it
     grows, only the dots come so far are drawn. */
  const drawnGraph = useMemo(() => (growth ? subgraph(shown, new Set(growth.order.slice(0, growth.count))) : shown), [growth, shown]);
  const shape = useMemo(() => graphShape(drawnGraph), [drawnGraph]);
  const context = local ? `local:${anchor}` : "all";
  const drawnIds = useMemo(() => drawnGraph.nodes.map((node) => node.id), [drawnGraph]);
  const { groups } = settings;
  const selectColors = useCallback((state: WorkspaceState) => groupColors(state.pages, drawnIds, groups), [drawnIds, groups]);
  const colors = useWorkspaceState(selectColors, sameColors);
  // The panel's shape is the layout's too, in steps; nothing before it is measured.
  const aspect = size.width && size.height ? Math.round(Math.min(3, Math.max(0.5, size.height / size.width)) * 4) / 4 : 0;

  /* What the frame loop reads and moves, outside React's renders: the
     simulation, the camera, and the elements it places. */
  const simulation = useRef<GraphSimulation | null>(null);
  const camera = useRef<Camera | null>(null);
  const nodeElements = useRef(new Map<string, SVGGElement>());
  const edgeElements = useRef(new Map<string, SVGLineElement>());
  const labelElements = useRef(new Map<string, SVGTextElement>());
  const nodeRef = useElementRefs(nodeElements);
  const edgeRef = useElementRefs(edgeElements);
  const labelRef = useElementRefs(labelElements);
  const request = useRef(0);
  const lastFrame = useRef(0);
  const holding = useRef<string | null>(null);
  const reduce = useRef(reducedMotion());

  const byId = useMemo(() => new Map(drawnGraph.nodes.map((node) => [node.id, node])), [drawnGraph]);
  const near = useMemo(() => neighbours(drawnGraph), [drawnGraph]);
  /** A dot's radius before the zoom grows it: busier dots are bigger, and
   *  every dot as big as the settings' Node size says. */
  const { node_size: nodeSize } = settings;
  const radii = useMemo(
    () => new Map(drawnGraph.nodes.map((node) => [node.id, (4 + Math.min(3, Math.sqrt(near.get(node.id)?.size ?? 0) * 0.8)) * nodeSize])),
    [drawnGraph, near, nodeSize],
  );
  const edgeByKey = useMemo(() => new Map(drawnGraph.edges.map((edge) => [edgeKey(edge), edge])), [drawnGraph]);
  /* Names show from further out the higher the Text fade threshold is set:
     each step of it halves, or doubles, the zoom they need. */
  const namesAt = NAMES_AT[local ? "local" : "all"] * 2 ** -settings.text_fade;
  // The dot in hand, else the one under the pointer, lights what it joins.
  const focus = held ?? hovered;
  const lit = focus && byId.has(focus) ? new Set([focus, ...(near.get(focus) ?? [])]) : null;

  const drawing = useRef({ radii, edgeByKey, lit, anchor, namesAt });
  useLayoutEffect(() => {
    drawing.current = { radii, edgeByKey, lit, anchor, namesAt };
  });

  /** Puts every dot, line and name where the simulation and the camera say. */
  const draw = useCallback(() => {
    const running = simulation.current;
    const shot = camera.current;
    if (!running || !shot) return;
    const { k, x: offsetX, y: offsetY } = shot.view;
    const grow = Math.min(1.5, Math.max(0.75, Math.sqrt(k)));
    const { radii: sizes, edgeByKey: edgesByKey, lit: bright, anchor: current, namesAt: threshold } = drawing.current;
    const screen = (id: string): Point | null => {
      const point = running.point(id);
      return point ? { x: point.x * k + offsetX, y: point.y * k + offsetY } : null;
    };
    for (const [id, element] of nodeElements.current) {
      const at = screen(id);
      if (at) element.setAttribute("transform", `translate(${at.x} ${at.y}) scale(${grow})`);
    }
    for (const [key, element] of edgeElements.current) {
      const edge = edgesByKey.get(key);
      const from = edge ? screen(edge.from) : null;
      const to = edge ? screen(edge.to) : null;
      if (!edge || !from || !to) continue;
      // Rim to rim: the dots are see-through, so a line under one would show
      // through it. Dots that touch have no line between them to draw.
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      const start = (sizes.get(edge.from) ?? 4) * grow;
      const end = (sizes.get(edge.to) ?? 4) * grow;
      const room = length > start + end;
      const ux = (to.x - from.x) / length;
      const uy = (to.y - from.y) / length;
      element.setAttribute("x1", String(room ? from.x + ux * start : from.x));
      element.setAttribute("y1", String(room ? from.y + uy * start : from.y));
      element.setAttribute("x2", String(room ? to.x - ux * end : from.x));
      element.setAttribute("y2", String(room ? to.y - uy * end : from.y));
    }
    // The page being read and what is lit always say their names; the rest
    // fade in with the zoom, and fade back beside what is lit.
    const fade = Math.min(1, Math.max(0, (k - threshold * 0.75) / (threshold * 0.25)));
    for (const [id, element] of labelElements.current) {
      const at = screen(id);
      if (!at) continue;
      element.setAttribute("x", String(at.x));
      element.setAttribute("y", String(at.y + (sizes.get(id) ?? 4) * grow + 11));
      const opacity = (id === current || bright?.has(id) ? 1 : fade) * (bright && !bright.has(id) ? 0.3 : 1);
      element.style.opacity = String(opacity);
      element.style.display = opacity < 0.02 ? "none" : "";
    }
  }, []);

  /* One frame: a few steps of the simulation, the camera a little nearer
     where it is heading, and everything drawn. It keeps going while anything
     moves or a dot is held, then stops until something wakes it. */
  const step = useCallback((now: number) => {
    request.current = 0;
    const running = simulation.current;
    const shot = camera.current;
    if (!running || !shot) return;
    const elapsed = lastFrame.current ? Math.min(64, now - lastFrame.current) : 16;
    lastFrame.current = now;
    let busy = false;
    if (reduce.current) {
      // Asked for less motion: it jumps to rest, the view to its place.
      if (holding.current) for (let steps = 0; steps < HELD_STEPS; steps += 1) running.tick();
      else if (!running.resting) running.run();
      shot.view = shot.target;
    } else {
      const steps = holding.current ? HELD_STEPS : SETTLE_STEPS;
      for (let count = 0; count < steps && !running.resting; count += 1) running.tick();
      busy = !running.resting;
      if (arrived(shot.view, shot.target)) {
        shot.view = shot.target;
      } else {
        const ease = 1 - Math.exp(-elapsed / EASE_MS);
        const { view, target } = shot;
        shot.view = { k: view.k + (target.k - view.k) * ease, x: view.x + (target.x - view.x) * ease, y: view.y + (target.y - view.y) * ease };
        busy = true;
      }
    }
    draw();
    if (busy || holding.current) {
      request.current = requestAnimationFrame(step);
    } else {
      lastFrame.current = 0;
    }
  }, [draw]);

  const wake = useCallback(() => {
    if (request.current) return;
    request.current = requestAnimationFrame(step);
  }, [step]);
  useEffect(() => () => cancelAnimationFrame(request.current), []);

  /* The forces the settings ask for. A change is felt at once: the layout
     warms and moves to answer, as Obsidian's does while a slider moves. */
  const forces = useMemo<GraphForces>(
    () => ({ center_force: settings.center_force, repel_force: settings.repel_force, link_force: settings.link_force, link_distance: settings.link_distance }),
    [settings.center_force, settings.link_distance, settings.link_force, settings.repel_force],
  );
  const forcesRef = useRef(forces);
  const growing = useRef(false);
  useLayoutEffect(() => {
    growing.current = growth !== null;
  });
  useEffect(() => {
    if (forcesRef.current === forces) return;
    forcesRef.current = forces;
    simulation.current?.setForces(forces);
    wake();
  }, [forces, wake]);

  /* A new graph — another page's surroundings, a page gained or lost, the
     panel reshaped — starts from where the dots are now: what stays glides
     to its new place, what is new comes in beside what it joins, and the
     view glides to fit where it will all come to rest. The shape stands for
     the graph here: a word typed moves nothing. While Animate grows it, the
     view holds still, and fits once it has grown. */
  useLayoutEffect(() => {
    if (!aspect) return;
    const next = new GraphSimulation(drawnGraph, simulation.current?.positions(), aspect, forcesRef.current);
    simulation.current = next;
    holding.current = null;
    setHeld(null);
    if (!growing.current || !camera.current) {
      const target = fit(next.predict(), size.width, size.height);
      camera.current = camera.current ? { ...camera.current, target, own: false } : { view: target, target, own: false };
    }
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, context, aspect]);

  /* Animate: the dots come in, in the order their pages were made — a
     fortieth of them at a time — and what they join with them. Asked for
     less motion, there is nothing to watch, so nothing happens. */
  const animate = () => {
    if (reduce.current || !shown.nodes.length) return;
    const order = shown.nodes
      .toSorted((left, right) => (left.created ?? 0) - (right.created ?? 0) || left.id.localeCompare(right.id))
      .map((node) => node.id);
    setGrowth({ order, count: 1 });
  };
  useEffect(() => {
    if (!growth) return;
    if (growth.count >= growth.order.length) {
      setGrowth(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setGrowth((current) => current && {
        ...current,
        count: Math.min(current.order.length, current.count + Math.max(1, Math.ceil(current.order.length / GROW_STEPS))),
      });
    }, GROW_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [growth]);

  // A panel resized is fitted again at once, unless the reader placed the view.
  useLayoutEffect(() => {
    const running = simulation.current;
    const shot = camera.current;
    if (!running || !shot || shot.own || !size.width || !size.height) return;
    const target = fit(running.predict(), size.width, size.height);
    camera.current = { view: target, target, own: false };
    draw();
  }, [draw, size.height, size.width]);

  // New elements are placed before they are painted.
  useLayoutEffect(() => {
    draw();
  });

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const width = Math.round(box.clientWidth);
      const height = Math.round(box.clientHeight);
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /* Scrolling or pinching zooms, about the pointer, easing there. Not a
     React handler: those are passive, and the page must not scroll or zoom
     instead. */
  const drawn = drawnGraph.nodes.length > 0;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !drawn) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const shot = camera.current;
      if (!shot) return;
      const rect = svg.getBoundingClientRect();
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const factor = Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.002));
      camera.current = { ...shot, target: zoomAt(shot.target, factor, { x: event.clientX - rect.left, y: event.clientY - rect.top }), own: true };
      wake();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [drawn, wake]);

  const open = (node: GraphNode, full: boolean) => onOpenPage(node.id, full);

  /* One press does three jobs: a press that stays put opens the dot under
     it; a drag that starts on a dot carries the dot, and what it joins
     follows; a drag anywhere else moves the drawing. */
  const gesture = useRef<{ pointer: number; x: number; y: number; view: View; moved: boolean; node: string | null } | null>(null);
  const inLayout = (event: ReactPointerEvent<SVGSVGElement>): Point | null => {
    const shot = camera.current;
    const svg = svgRef.current;
    if (!shot || !svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: (event.clientX - rect.left - shot.view.x) / shot.view.k, y: (event.clientY - rect.top - shot.view.y) / shot.view.k };
  };
  const letGo = (id: string) => {
    simulation.current?.release(id);
    holding.current = null;
    setHeld(null);
    wake();
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !camera.current) return;
    const node = (event.target as Element).closest<SVGGElement>("[data-node]")?.dataset.node ?? null;
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, view: camera.current.view, moved: false, node };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    if (!current.moved) {
      current.moved = true;
      if (current.node) {
        holding.current = current.node;
        setHeld(current.node);
      } else {
        setPanning(true);
        setHovered(null);
      }
    }
    if (current.node) {
      const point = inLayout(event);
      if (point) simulation.current?.hold(current.node, point);
      wake();
      return;
    }
    const view = { ...current.view, x: current.view.x + dx, y: current.view.y + dy };
    camera.current = { view, target: view, own: true };
    draw();
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    gesture.current = null;
    setPanning(false);
    if (current.node && current.moved) {
      letGo(current.node);
      return;
    }
    const node = !current.moved && current.node ? byId.get(current.node) : undefined;
    if (node) open(node, event.metaKey || event.ctrlKey);
  };
  const onPointerCancel = () => {
    const current = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (current?.node && current.moved) letGo(current.node);
  };

  const refit = () => {
    const running = simulation.current;
    const shot = camera.current;
    if (!running || !shot) return;
    camera.current = { ...shot, target: fit(running.predict(), size.width, size.height), own: false };
    wake();
  };

  const pageCount = drawnGraph.nodes.length;
  const titleOf = (node: GraphNode) => node.label;

  const choose = (next: Scope) => {
    setScope(next);
    writeScope(variant, next);
  };

  const onNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, node: GraphNode) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open(node, event.metaKey || event.ctrlKey);
  };
  // A dot reached from the keyboard lights up as one under the pointer does.
  const onNodeFocus = (event: ReactFocusEvent<SVGGElement>, id: string) => {
    if (event.currentTarget.matches(":focus-visible")) setHovered(id);
  };

  // Names go on top of every line and dot; the lit ones on top of those.
  const labelled = drawnGraph.nodes.toSorted((left, right) => Number(Boolean(lit?.has(left.id))) - Number(Boolean(lit?.has(right.id))));
  // One arrowhead per drawing — two graphs can be on screen at once.
  const arrowId = `graph-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const tools = (
    <>
        <Tooltip label="Around this page">
          <button
            type="button"
            className={`icon-btn ${local ? "is-active" : ""}`}
            aria-label="Around this page"
            aria-pressed={local}
            disabled={!anchor}
            onClick={() => choose("local")}
          >
            <LocateFixed size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Everything">
          <button
            type="button"
            className={`icon-btn ${!local ? "is-active" : ""}`}
            aria-label="Everything"
            aria-pressed={!local}
            onClick={() => choose("all")}
          >
            <Orbit size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Fit to view">
          <button type="button" className="icon-btn" aria-label="Fit to view" onClick={refit}>
            <Maximize size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Graph settings">
          <button
            type="button"
            className={`icon-btn ${settingsOpen ? "is-active" : ""}`}
            aria-label="Graph settings"
            aria-pressed={settingsOpen}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings2 size={16} />
          </button>
        </Tooltip>
        {onOpenAsPage ? (
          <Tooltip label="Open as full page">
            <button type="button" className="icon-btn" aria-label="Open as full page" onClick={onOpenAsPage}>
              <ArrowUpRight size={16} />
            </button>
          </Tooltip>
        ) : null}
    </>
  );

  return (
    <>
      {variant === "sidebar" ? <div className="sidebar__tools" role="toolbar" aria-label="Graph">{tools}</div> : null}

      <div ref={boxRef} className={`graph graph--${variant}`}>
        {variant === "page" ? <div className="graph__tools" role="toolbar" aria-label="Graph">{tools}</div> : null}
        {drawn ? (
          <svg
            ref={svgRef}
            className={`graph__canvas ${panning ? "is-panning" : ""} ${held ? "is-holding" : ""} ${lit ? "is-lit" : ""}`}
            role="group"
            aria-label={`Graph: ${pageCount} ${pageCount === 1 ? "page" : "pages"}`}
            style={{ ["--graph-line" as string]: String(settings.link_thickness) }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
          >
            {/* Arrows point from the page that holds or links to the page
                held or linked to — drawn only when asked for. */}
            {settings.arrows ? (
              <defs>
                <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                  <path className="graph__arrow" d="M 0 1 L 9 5 L 0 9 z" />
                </marker>
              </defs>
            ) : null}
            <g>
              {drawnGraph.edges.map((item) => {
                const on = Boolean(lit && focus && (item.from === focus || item.to === focus));
                return (
                  <line
                    key={edgeKey(item)}
                    ref={edgeRef(edgeKey(item))}
                    className={`graph__edge${on ? " is-on" : ""}${lit && !on ? " is-faded" : ""}`}
                    markerEnd={settings.arrows ? `url(#${arrowId})` : undefined}
                  />
                );
              })}
            </g>
            <g>
              {drawnGraph.nodes.map((node) => {
                const radius = radii.get(node.id) ?? 4;
                const classes = [
                  "graph__node",
                  "graph__node--page",
                  node.id === anchor ? "is-current" : "",
                  node.id === focus ? "is-hovered" : "",
                  node.id === held ? "is-held" : "",
                  lit && !lit.has(node.id) ? "is-faded" : "",
                ].filter(Boolean).join(" ");
                return (
                  <g
                    key={node.id}
                    ref={nodeRef(node.id)}
                    className={classes}
                    data-node={node.id}
                    data-tone={colors.get(node.id)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${node.label}`}
                    aria-current={node.id === anchor ? "page" : undefined}
                    onPointerEnter={() => { if (!gesture.current?.moved) setHovered(node.id); }}
                    onPointerLeave={() => setHovered((current) => (current === node.id ? null : current))}
                    onFocus={(event) => onNodeFocus(event, node.id)}
                    onBlur={() => setHovered((current) => (current === node.id ? null : current))}
                    onKeyDown={(event) => onNodeKeyDown(event, node)}
                  >
                    <title>{titleOf(node)}</title>
                    {/* A wider ring than the dot, so a small dot is easy to hit. */}
                    <circle className="graph__hit" r={Math.max(9, radius + 4)} />
                    <circle className="graph__dot" r={radius} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
            </g>
            <g aria-hidden="true">
              {labelled.map((node) => (
                <text
                  key={node.id}
                  ref={labelRef(node.id)}
                  className={[
                    "graph__label",
                    node.id === anchor ? "is-current" : "",
                    lit?.has(node.id) ? "is-lit" : "",
                  ].filter(Boolean).join(" ")}
                  textAnchor="middle"
                >
                  {node.id === focus ? node.label : shortened(node.label)}
                </text>
              ))}
            </g>
          </svg>
        ) : (
          <div className="sidebar__empty">
            <Waypoints size={18} />
            <p>Nothing to draw yet.</p>
          </div>
        )}
        {settingsOpen ? (
          <GraphSettingsPanel
            settings={settings}
            local={local}
            onChange={setSettings}
            onAnimate={animate}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
      </div>
    </>
  );
}
