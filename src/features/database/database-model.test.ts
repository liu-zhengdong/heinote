import { describe, expect, it } from "vitest";
import type { DatabaseConfig, DatabaseProperty, NotePage } from "../../core/types";
import { moveProperty, moveRowOrder } from "./database-model";

const prop = (id: string, type: DatabaseProperty["type"]): DatabaseProperty => ({ id, name: id, type });

/** A database holding the properties it's given, and nothing else the
 *  tests look at. */
const config = (...properties: DatabaseProperty[]): DatabaseConfig => ({
  properties,
  views: [],
});

const ids = (next: DatabaseConfig): string[] => next.properties.map((property) => property.id);

describe("moveProperty", () => {
  it("moves a property down within its own group", () => {
    const next = moveProperty(config(prop("a", "text"), prop("b", "number"), prop("c", "date")), "a", 1);
    expect(ids(next)).toEqual(["b", "a", "c"]);
  });

  it("moves a property to the first place of its group", () => {
    const next = moveProperty(config(prop("a", "text"), prop("b", "number"), prop("c", "date")), "c", 0);
    expect(ids(next)).toEqual(["c", "a", "b"]);
  });

  it("clamps a target past the group's end to the end", () => {
    const next = moveProperty(config(prop("a", "text"), prop("b", "number")), "a", 99);
    expect(ids(next)).toEqual(["b", "a"]);
  });

  it("leaves a single property where it is", () => {
    const start = config(prop("a", "text"));
    const next = moveProperty(start, "a", 0);
    expect(ids(next)).toEqual(["a"]);
    expect(next.properties).not.toBe(start.properties);
  });

  it("treats an unknown property as no move at all", () => {
    const start = config(prop("a", "text"), prop("b", "number"));
    expect(moveProperty(start, "gone", 0)).toBe(start);
  });

  it("counts a meta column's place only among the meta columns", () => {
    const next = moveProperty(
      config(prop("a", "text"), prop("created", "created_time"), prop("edited", "last_edited_time")),
      "edited", 0);
    expect(ids(next)).toEqual(["a", "edited", "created"]);
  });

  it("keeps an ordinary property out of the meta columns' places", () => {
    /* The Columns panel never lets a row drop across the line; a write
       asked to anyway lands at its own group's end. */
    const next = moveProperty(
      config(prop("a", "text"), prop("created", "created_time"), prop("edited", "last_edited_time")),
      "a", 99);
    expect(ids(next)).toEqual(["a", "created", "edited"]);
  });

  it("tidies properties a raw insert left between the meta columns", () => {
    /* `insertProperty` takes any index, so a meta column can sit among the
       ordinary ones; one move puts every meta column back at the end. */
    const next = moveProperty(
      config(prop("a", "text"), prop("created", "created_time"), prop("b", "number"), prop("c", "date")),
      "a", 1);
    expect(ids(next)).toEqual(["b", "a", "c", "created"]);
  });

  it("keeps every view setting keyed by property id as it was", () => {
    const start: DatabaseConfig = {
      properties: [prop("a", "text"), prop("b", "number")],
      views: [{
        id: "v1",
        name: "Table",
        kind: "table",
        hidden: ["b"],
        sorts: [{ property_id: "a", direction: "asc" }],
        calcs: { a: "count" },
        widths: { a: 240 },
      }],
    };
    const next = moveProperty(start, "a", 1);
    expect(next.views).toEqual(start.views);
  });
});

/** A row stub for `moveRowOrder`: only `id` and `row_order` are read. */
const row = (id: string, order: number): NotePage =>
  ({ id, row_order: order }) as unknown as NotePage;

describe("moveRowOrder", () => {
  const rows = [row("a", 1024), row("b", 2048), row("c", 3072)];
  const NOW = 10_000;

  it("lands a row at the midpoint of the gap it was dropped into", () => {
    const moved = moveRowOrder(rows, "c", "a", "before", NOW);
    expect(moved?.row_order).toBe(512);
    expect(moved?.rewrite).toBeUndefined();
  });

  it("lands a row after its boundary", () => {
    const moved = moveRowOrder(rows, "a", "b", "after", NOW);
    expect(moved?.row_order).toBe(2560);
  });

  it("takes a key below the first row when dropped before it", () => {
    const moved = moveRowOrder(rows, "c", "a", "before", NOW);
    expect(moved!.row_order).toBeLessThan(1024);
    expect(moved!.row_order).toBeGreaterThan(0);
  });

  it("takes a fresh key after the last row when dropped last", () => {
    const moved = moveRowOrder(rows, "a", null, "after", NOW);
    expect(moved!.row_order).toBeGreaterThanOrEqual(3073);
  });

  it("dropping a row onto itself or a missing boundary moves nothing", () => {
    expect(moveRowOrder(rows, "a", "a", "after", NOW)).toBeNull();
    expect(moveRowOrder(rows, "a", "gone", "after", NOW)).toBeNull();
    expect(moveRowOrder(rows, "gone", "a", "after", NOW)).toBeNull();
  });

  it("moves nothing when the neighbours it lands between tie", () => {
    /* Two rows holding one key have no gap to split — and nothing should
       ever have made them tie, so the drop is refused rather than guessed. */
    expect(moveRowOrder([row("a", 1), row("b", 1), row("c", 2)], "c", "a", "after", NOW)).toBeNull();
  });

  it("refuses a gap worn too thin and rewrites the whole order instead", () => {
    const thin = [row("a", 1), row("b", 1 + 1e-6), row("c", 2)];
    const moved = moveRowOrder(thin, "c", "a", "after", NOW);
    expect(moved).not.toBeNull();
    expect(moved!.rewrite).toBeDefined();
    /* a, c, b — c spliced into the worn gap, all on fresh steps. */
    expect(moved!.rewrite).toEqual({ a: 1024, c: 2048, b: 3072 });
    expect(moved!.row_order).toBe(2048);
  });

  it("dropping last after thin rows still takes a fresh key, no rewrite", () => {
    /* There is no gap to wear out after the last row — the drop lands at
       `now`, past them. */
    const thin = [row("a", 1), row("b", 1 + 1e-6)];
    const moved = moveRowOrder(thin, "a", null, "after", NOW);
    expect(moved!.rewrite).toBeUndefined();
    expect(moved!.row_order).toBe(NOW);
  });
});
