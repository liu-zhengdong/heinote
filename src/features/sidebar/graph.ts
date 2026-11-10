import { lineLink, pageName } from "../../core/block-tree";
import { pageAncestry } from "../../core/page-tree";
import { DEFAULT_GRAPH_SETTINGS, matchesGraphQuery, pagePath, parseGraphQuery } from "../../core/graph-settings";
import type { GraphSettings, NotePage } from "../../core/types";
import type { BlockReference } from "../editor/mentions";

/* The graph of a workspace: every page — its blocks among them, a block
   being a page, and a database's rows, the pages it holds — what holds what,
   and what links to what: Obsidian's graph. Pure, so it is worked out once
   per change and can be tested on its own. */

export interface GraphNode {
  id: string;
  label: string;
  icon?: string;
  /** When the page was made, in ms — the order Animate grows the graph in. */
  created?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Why the two are joined — `holds`: a page holds the pages in it, its
   *  blocks too, and a database its rows; `links`: a link in one page to
   *  another. Both are drawn alike, as plain lines, as Obsidian draws them. */
  kind: "holds" | "links";
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Point = { x: number; y: number };

/** Every page not in the trash is drawn — a database's rows too, joined to
 *  it as the pages it holds, as the page list shows them under it. */
function listed(page: NotePage | undefined): page is NotePage {
  return Boolean(page?.id && !page.archived);
}

export function buildGraph(pages: Record<string, NotePage>, references: ReadonlyMap<string, readonly BlockReference[]>): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const edge = (from: string, to: string, kind: GraphEdge["kind"]) => {
    // Two pages are joined by one line, as in Obsidian: a link along a line
    // that already holds, or a link back along a link, is the same line,
    // drawn once. (Holds come first, so a line that holds stays one.)
    const pair = from < to ? `${from}\n${to}` : `${to}\n${from}`;
    if (from === to || !nodes.has(from) || !nodes.has(to) || seen.has(pair)) return;
    seen.add(pair);
    edges.push({ from, to, kind });
  };
  const shown = Object.values(pages)
    .filter((page) => listed(page))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  for (const page of shown) {
    nodes.set(page.id, {
      id: page.id,
      label: pageName(page),
      ...(page.icon ? { icon: page.icon } : {}),
      created: Date.parse(page.created_at) || 0,
    });
  }
  for (const page of shown) {
    if (page.parent_id) edge(page.parent_id, page.id, "holds");
  }
  for (const [target, found] of references) {
    if (!nodes.has(target)) continue;
    for (const reference of found) {
      const source = pages[reference.pageId];
      if (!source || !nodes.has(source.id)) continue;
      // A page's own row in its parent is where it lives: held, not linked.
      const paragraph = source.block_tree.by_id[reference.paragraphId];
      if (paragraph && lineLink(paragraph)?.page_id === target && pages[target]?.parent_id === source.id) continue;
      edge(source.id, target, "links");
    }
  }
  return { nodes: [...nodes.values()], edges };
}

/** The node a page is drawn as: itself — or, for one in the trash, the
 *  nearest page above it that is not. */
export function graphAnchor(pages: Record<string, NotePage>, pageId: string | null): string | null {
  return pageAncestry(pages, pageId).findLast((page) => listed(page))?.id ?? null;
}

/** What the graph's filters leave of it (Obsidian's Filters): the pages its
 *  search finds, database rows only if asked for, and then — unless they are
 *  asked for — no pages joined to nothing. `keep`, the page a local graph is
 *  around, always stays. Unfiltered, the graph itself comes back. */
export function filterGraph(
  graph: Graph,
  pages: Readonly<Record<string, NotePage>>,
  filters: Pick<GraphSettings, "search" | "rows" | "orphans">,
  keep: string | null = null,
): Graph {
  const terms = parseGraphQuery(filters.search);
  if (!terms.length && filters.rows && filters.orphans) return graph;
  const kept = new Set<string>();
  for (const node of graph.nodes) {
    const page = pages[node.id];
    const row = Boolean(page?.parent_id && pages[page.parent_id]?.kind === "database");
    if (node.id !== keep) {
      if (!filters.rows && row) continue;
      if (terms.length && !matchesGraphQuery(terms, { name: node.label, path: pagePath(pages, node.id) })) continue;
    }
    kept.add(node.id);
  }
  const edges = graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  if (!filters.orphans) {
    const joined = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
    for (const id of [...kept]) if (id !== keep && !joined.has(id)) kept.delete(id);
  }
  return subgraph(graph, kept);
}

/** The part of a graph whose nodes are in `ids`. */
export function subgraph(graph: Graph, ids: ReadonlySet<string>): Graph {
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}

/** Each node's neighbours, whichever way their edges point. */
export function neighbours(graph: Graph): Map<string, Set<string>> {
  const near = new Map<string, Set<string>>();
  for (const { from, to } of graph.edges) {
    near.set(from, (near.get(from) ?? new Set()).add(to));
    near.set(to, (near.get(to) ?? new Set()).add(from));
  }
  return near;
}

/** Everything within `hops` of `centers`, whichever way its edges point. */
export function neighbourhood(graph: Graph, centers: readonly string[], hops = 1): Graph {
  const near = neighbours(graph);
  const present = new Set(graph.nodes.map((node) => node.id));
  const kept = new Set(centers.filter((id) => present.has(id)));
  let frontier = [...kept];
  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of near.get(id) ?? []) {
        if (kept.has(other)) continue;
        kept.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return subgraph(graph, kept);
}

/** What the layout depends on — which nodes, joined how — and nothing it
 *  does not: a renamed page keeps its place. */
export function graphShape(graph: Graph): string {
  return `${graph.nodes.map((node) => node.id).toSorted().join(",")}|${graph.edges.map((item) => `${item.from}>${item.to}`).toSorted().join(",")}`;
}

/** Two graphs drawn the same: the same shape, every dot named and marked
 *  the same. Words written in a page change neither. */
export function sameGraph(left: Graph, right: Graph): boolean {
  if (left === right) return true;
  if (left.nodes.length !== right.nodes.length || left.edges.length !== right.edges.length) return false;
  const named = new Map(left.nodes.map((node) => [node.id, node]));
  return right.nodes.every((node) => named.get(node.id)?.label === node.label && named.get(node.id)?.icon === node.icon)
    && graphShape(left) === graphShape(right);
}

function spin(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return ((hash >>> 0) % 6283) / 1000;
}

/** How far apart two joined nodes like to sit, in layout units, at
 *  Obsidian's default link distance (250). */
const SPAN = 40;

/** The forces that lay the graph out, as the graph settings say them on
 *  Obsidian's scales: the pull to the middle, how hard every two push apart,
 *  how hard a line pulls, and how long a line likes to be. */
export type GraphForces = Pick<GraphSettings, "center_force" | "repel_force" | "link_force" | "link_distance">;
/** Below this heat the simulation is at rest. */
const ALPHA_MIN = 0.001;

/** A damped force simulation of the graph (as d3-force runs one), stepped a
 *  tick at a time so the drawing can move as it settles — and a node can be
 *  held where the pointer is while the rest answer it, as in Obsidian.
 *  Joined nodes pull to a span apart, every two push apart, and all drift to
 *  the middle, from a fixed start, so the same graph always lands the same
 *  way. Given where the last one put things, it starts from there, gently —
 *  warmer the more of it is new — so a graph that gained a page keeps its
 *  shape and the page settles near what it joins. `aspect` (height ÷ width
 *  of where it is drawn) draws it taller in a tall panel, where a round one
 *  would leave most of it empty. Units are arbitrary; the view fits them. */
export class GraphSimulation {
  readonly ids: readonly string[];
  /** How hot it is: how far anything still moves each tick. */
  alpha: number;
  private readonly index: ReadonlyMap<string, number>;
  private readonly links: ReadonlyArray<readonly [number, number]>;
  private readonly degree: Float64Array;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly aspect: number;
  private readonly decay: number;
  /* The forces, set from `GraphForces` (setForces). */
  private pullX = 0;
  private pullY = 0;
  private charge = 0;
  private span = SPAN;
  private strength = 1;
  /** Nodes held in place — by the pointer — and where. */
  private readonly held = new Map<number, Point>();
  /** The heat it settles toward: none, unless something is being held. */
  private target = 0;

  constructor(graph: Graph, previous: ReadonlyMap<string, Point> | undefined, aspect: number, forces: GraphForces) {
    const ids = graph.nodes.map((node) => node.id).toSorted();
    const count = ids.length;
    const index = new Map(ids.map((id, position) => [id, position]));
    const links = graph.edges
      .map((item) => [index.get(item.from), index.get(item.to)] as const)
      .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined && pair[0] !== pair[1]);
    const degree = new Float64Array(count);
    for (const [a, b] of links) {
      degree[a] += 1;
      degree[b] += 1;
    }
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    const known = ids.map((id) => previous?.get(id));
    const warm = known.some(Boolean);
    ids.forEach((id, position) => {
      const was = known[position];
      if (was) {
        x[position] = was.x;
        y[position] = was.y;
        return;
      }
      // New to a laid-out graph: beside what it joins, if any of that is placed.
      const beside = warm
        ? links.flatMap(([a, b]) => (a === position ? [b] : b === position ? [a] : [])).map((other) => known[other]).filter((point): point is Point => Boolean(point))
        : [];
      const angle = warm ? spin(id) : position * 2.399963;
      if (beside.length) {
        x[position] = beside.reduce((sum, point) => sum + point.x, 0) / beside.length + Math.cos(angle) * SPAN * 0.5;
        y[position] = beside.reduce((sum, point) => sum + point.y, 0) / beside.length + Math.sin(angle) * SPAN * 0.5;
        return;
      }
      const radius = Math.sqrt(position + 0.5) * SPAN * 0.5;
      x[position] = (radius * Math.cos(angle)) / Math.sqrt(aspect);
      y[position] = radius * Math.sin(angle) * Math.sqrt(aspect);
    });
    this.ids = ids;
    this.index = index;
    this.links = links;
    this.degree = degree;
    this.x = x;
    this.y = y;
    this.vx = new Float64Array(count);
    this.vy = new Float64Array(count);
    this.aspect = aspect;
    this.applyForces(forces);
    // Big workspaces settle in fewer, longer steps: every tick weighs every pair.
    const ticks = count > 600 ? 90 : count > 300 ? 160 : 300;
    this.decay = 1 - Math.pow(ALPHA_MIN, 1 / ticks);
    const fresh = count ? known.filter((point) => !point).length / count : 0;
    this.alpha = warm ? Math.max(0.25, fresh) : 1;
  }

  private applyForces(forces: GraphForces): void {
    // The pull to the middle is stronger across than down a tall panel.
    const pull = 0.2 * forces.center_force;
    this.pullX = pull * Math.sqrt(this.aspect);
    this.pullY = pull / Math.sqrt(this.aspect);
    this.charge = -SPAN * SPAN * 0.01 * forces.repel_force;
    this.strength = forces.link_force;
    this.span = SPAN * (forces.link_distance / DEFAULT_GRAPH_SETTINGS.link_distance);
  }

  /** New forces, felt at once: the layout warms up and moves to answer. */
  setForces(forces: GraphForces): void {
    this.applyForces(forces);
    this.alpha = Math.max(this.alpha, 0.3);
  }

  /** Whether it has come to rest: nothing held, nothing still moving. */
  get resting(): boolean {
    return this.target === 0 && this.alpha <= ALPHA_MIN;
  }

  /** One step: every force at the present heat, then everything moves. */
  tick(): void {
    const { x, y, vx, vy, degree } = this;
    const count = this.ids.length;
    const alpha = (this.alpha += (this.target - this.alpha) * this.decay);
    // Joined nodes pull (or push) toward a span apart; the busier end moves less.
    for (const [a, b] of this.links) {
      let ex = x[b] + vx[b] - x[a] - vx[a];
      let ey = y[b] + vy[b] - y[a] - vy[a];
      if (ex === 0 && ey === 0) ex = 1e-3;
      const length = Math.hypot(ex, ey);
      const pull = ((length - this.span) / length) * alpha * this.strength / Math.min(degree[a], degree[b]);
      const bias = degree[a] / (degree[a] + degree[b]);
      ex *= pull;
      ey *= pull;
      vx[b] -= ex * bias;
      vy[b] -= ey * bias;
      vx[a] += ex * (1 - bias);
      vy[a] += ey * (1 - bias);
    }
    // Every two push apart…
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        let ex = x[b] - x[a];
        let ey = y[b] - y[a];
        if (ex === 0 && ey === 0) {
          ex = (b - a) * 1e-3;
          ey = 1e-3;
        }
        const push = (this.charge * alpha) / Math.max(ex * ex + ey * ey, 1);
        vx[a] += ex * push;
        vy[a] += ey * push;
        vx[b] -= ex * push;
        vy[b] -= ey * push;
      }
    }
    // …and everything drifts to the middle, so islands stay near — but what
    // is held stays where it is held.
    for (let node = 0; node < count; node += 1) {
      const pinned = this.held.get(node);
      if (pinned) {
        x[node] = pinned.x;
        y[node] = pinned.y;
        vx[node] = 0;
        vy[node] = 0;
        continue;
      }
      vx[node] -= x[node] * this.pullX * alpha;
      vy[node] -= y[node] * this.pullY * alpha;
      vx[node] *= 0.6;
      vy[node] *= 0.6;
      x[node] += vx[node];
      y[node] += vy[node];
    }
  }

  /** Runs to rest, and says where everything came to. */
  run(): Map<string, Point> {
    while (!this.resting) this.tick();
    return this.positions();
  }

  /** Where everything will come to rest, left alone from here — this
   *  simulation itself not moved on. */
  predict(): Map<string, Point> {
    const copy = Object.create(GraphSimulation.prototype) as GraphSimulation;
    Object.assign(copy, this, {
      x: this.x.slice(), y: this.y.slice(), vx: this.vx.slice(), vy: this.vy.slice(), held: new Map(), target: 0,
    });
    return copy.run();
  }

  /** Where one node is now. */
  point(id: string): Point | undefined {
    const node = this.index.get(id);
    return node === undefined ? undefined : { x: this.x[node], y: this.y[node] };
  }

  positions(): Map<string, Point> {
    return new Map(this.ids.map((id, node) => [id, { x: this.x[node], y: this.y[node] }]));
  }

  /** Holds a node at a place — under the pointer — and keeps the rest
   *  answering it; `release` lets it go back among them. */
  hold(id: string, point: Point): void {
    const node = this.index.get(id);
    if (node === undefined) return;
    this.held.set(node, point);
    this.x[node] = point.x;
    this.y[node] = point.y;
    this.target = 0.3;
  }

  release(id: string): void {
    const node = this.index.get(id);
    if (node !== undefined) this.held.delete(node);
    if (!this.held.size) this.target = 0;
  }
}
