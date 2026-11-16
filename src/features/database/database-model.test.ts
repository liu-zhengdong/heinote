import { describe, expect, it } from "vitest";
import type { DatabaseConfig, DatabaseProperty } from "../../core/types";
import { moveProperty } from "./database-model";

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
