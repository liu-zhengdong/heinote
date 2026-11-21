import type { LiveCollection } from "./live";

export type RichText = Array<{ text?: string; embed?: Record<string, unknown>; marks?: Record<string, unknown> }>;
export type RecordPatch<R> = Partial<{ [K in keyof R]: R[K] | null }>;
export interface FileUrl { url: string | null; ready: Promise<string>; release(): void }

interface FieldStub {
  optional(): FieldStub;
  describe(_text: string): FieldStub;
  default(_value: unknown): FieldStub;
}

const stub: FieldStub = {
  optional: () => stub,
  describe: () => stub,
  default: () => stub,
};
const field = (..._args: unknown[]) => stub;

/* Browser shim of ./schema.ts: keeps identical exports for schema.ts while
   omitting zod's runtime validator from client bundles (validation lives on the server). */
export const t = {
  string: field,
  id: field,
  name: field,
  bool: field,
  number: field,
  int: field,
  choice: field,
  list: field,
  object: field,
  union: field,
  record: field,
  json: field,
  date: field,
  richText: field,
};

export class CollectionHandle<R extends object> {
  constructor(readonly name: string, readonly fields: unknown, readonly scope = "personal") {}
  in(spaceId: string): CollectionHandle<R> { return new CollectionHandle(this.name, this.fields, spaceId); }
  live(options: { lazy?: boolean; paused?: boolean; seedPageId?: string } = {}): Promise<LiveCollection<R>> {
    return import("./live").then(({ LiveCollection }) => LiveCollection.open<R>(this.name, this.scope, options));
  }
}

type CollectionSpec = { fields: Record<string, unknown>; scopes?: string[]; agents?: string; retention?: unknown };
type Operation = { input: Record<string, unknown>; runs: string; effect: string; description: string };

export function schema<C extends Record<string, CollectionSpec>, O extends Record<string, Operation>>(definition: {
  collections: C; operations: O; services: Record<string, string>;
}) {
  const collections = Object.fromEntries(
    Object.entries(definition.collections).map(([name, spec]) => [name, new CollectionHandle(name, spec.fields)]),
  ) as {
    [K in keyof C]: CollectionHandle<Record<string, unknown>>;
  };
  return {
    ...collections,
    definition,
    commands: (_handlers: Partial<{ [K in keyof O]: (input: Record<string, unknown>) => unknown }>) => () => {},
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
