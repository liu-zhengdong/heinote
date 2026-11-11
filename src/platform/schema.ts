import { z } from "zod";
import { LiveCollection } from "./live";

export type RichText = Array<{ text?: string; embed?: Record<string, unknown>; marks?: Record<string, unknown> }>;
export type RecordPatch<R> = Partial<{ [K in keyof R]: R[K] | null }>;
export interface FileUrl { url: string | null; ready: Promise<string>; release(): void }

export const t = {
  string: (max?: number) => max ? z.string().max(max) : z.string(),
  id: () => z.string().min(1).max(256),
  name: () => z.string().max(500),
  bool: () => z.boolean(),
  number: (min?: number, max?: number) => z.number().min(min ?? -Infinity).max(max ?? Infinity),
  int: (min?: number, max?: number) => z.number().int().min(min ?? -Number.MAX_SAFE_INTEGER).max(max ?? Number.MAX_SAFE_INTEGER),
  choice: <const V extends readonly string[]>(...values: V) => z.enum(values),
  list: <T extends z.ZodType>(item: T, max?: number) => z.array(item).max(max ?? 100000),
  object: <F extends z.ZodRawShape>(fields: F) => z.object(fields),
  union: <T extends readonly [z.ZodType, ...z.ZodType[]]>(options: T) => z.union(options),
  record: <V extends z.ZodType>(value: V) => z.record(z.string(), value),
  json: (_shape: { type: "object" }) => z.record(z.string(), z.unknown()),
  date: () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  richText: () => z.array(z.object({
    text: z.string().optional(), embed: z.record(z.string(), z.unknown()).optional(),
    marks: z.record(z.string(), z.unknown()).optional(),
  })).max(100000),
};

export class CollectionHandle<R extends object> {
  constructor(readonly name: string, readonly fields: z.ZodType<R>, readonly scope = "personal") {}
  in(spaceId: string): CollectionHandle<R> { return new CollectionHandle(this.name, this.fields, spaceId); }
  live(): Promise<LiveCollection<R>> { return LiveCollection.open(this.name, this.scope); }
}

type CollectionSpec = { fields: z.ZodRawShape; scopes?: string[]; agents?: string; retention?: unknown };
type Operation = { input: z.ZodRawShape; runs: string; effect: string; description: string };

export function schema<C extends Record<string, CollectionSpec>, O extends Record<string, Operation>>(definition: {
  collections: C; operations: O; services: Record<string, string>;
}) {
  const collections = Object.fromEntries(Object.entries(definition.collections).map(([name, spec]) => [name, new CollectionHandle(name, z.object(spec.fields))])) as {
    [K in keyof C]: CollectionHandle<z.infer<z.ZodObject<C[K]["fields"]>>>;
  };
  return {
    ...collections, definition,
    // Standalone agents use the server API. Window commands retain their types.
    commands: (_handlers: Partial<{ [K in keyof O]: (input: z.infer<z.ZodObject<O[K]["input"]>>) => unknown }>) => () => {},
    cards: { call: async (_operation: string, _input: { url: string }): Promise<unknown> => null },
    web: { request: async (_operation: string, _input: { url: string }): Promise<{ status: number; contentType: string; bodyBase64: string | null }> => ({ status: 503, contentType: "", bodyBase64: null }) },
  };
}

export const fonts = { load: async (_family: string) => {} };
export const routes = { listen: (listener: (route: string) => void) => {
  const onPop = () => listener(location.pathname + location.search + location.hash);
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
} };
export const log = { error: async (message: string, data: unknown) => { console.error(message, data); } };
export const isRetryable = (error: unknown) => error instanceof TypeError || (error as { status?: number })?.status === 503;
export type { LiveCollection } from "./live";
