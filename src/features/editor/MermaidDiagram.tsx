import { memo, useEffect, useRef, useState } from "react";

/* A code block whose language is Mermaid gets its diagram drawn here.

   Pele — Obsidian's Mermaid engine — is a chunk of its own, fetched the
   first time a page draws a Mermaid block: most pages have none. Once the
   engine is up, `mountAsync` hands back a Mounted the diagram keeps and
   pushes edits into with `update()`; a change of diagram type loads that
   type first, as pele/lazy wants. Source text stays the block's truth —
   what the mount can't draw, it shows as its own error layer, and when the
   engine itself can't be had at all the hint line says so and the source
   is all there is to see. The next diagram drawn after that tries the
   chunk again, as the highlighter's loader does. */

interface PeleMounted {
  readonly source: string;
  update(text: string): void;
  destroy(): void;
}

interface PeleLazy {
  mountAsync(element: HTMLElement, text: string, options?: { links?: boolean; images?: boolean; zoom?: boolean }): Promise<PeleMounted>;
  detectType(text: string): string | null;
  load(type: string | null): Promise<boolean>;
}

let pele: PeleLazy | null = null;
let loading: Promise<PeleLazy | null> | null = null;

function peleModule(): Promise<PeleLazy | null> {
  if (pele) return Promise.resolve(pele);
  loading ??= (import("pele/lazy") as Promise<PeleLazy>)
    .then((module) => (pele = module))
    .catch(() => {
      loading = null;
      return null;
    });
  return loading;
}

/* Diagram text a step under the page's 16px body: labels read as captions,
   not as competing text. Pele derives every other size from this one. */
const OPTIONS = { links: false, images: false, zoom: false, fontSize: 14 } as const;

export const MermaidDiagram = memo(function MermaidDiagram({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<PeleMounted | null>(null);
  const engine = useRef<PeleLazy | null>(null);
  const latest = useRef(text);
  latest.current = text;
  const [down, setDown] = useState(false);

  /** An edit's way in: a type the mount hasn't met goes through load()
   *  first, else update() takes it straight. */
  const push = (value: string) => {
    const diagram = mounted.current;
    const module = engine.current;
    if (!diagram || !module || diagram.source === value) return;
    // `latest` not `value`: a slower load() must not resurrect an older
    // text over a newer one when type changes interleave. A parse failure
    // or a thrown detect lands in the mount's own error layer — nothing
    // here may escape into React.
    const go = () => { try { mounted.current?.update(latest.current); } catch { /* the mount's layer shows it */ } };
    let type: string | null = null;
    try { type = module.detectType(value); } catch { /* undetectable */ }
    let current: string | null = null;
    try { current = module.detectType(diagram.source); } catch { /* undetectable */ }
    if (type && type !== current) {
      void module.load(type).then(go);
    } else {
      go();
    }
  };

  /* One mount per block: mountAsync resolves with `latest`, edits already
     typed meanwhile land through push. The mount dies with the component —
     nothing else tears it down, so a text change never rebuilds it. */
  useEffect(() => {
    let alive = true;
    void peleModule().then((module) => {
      if (!module) {
        if (alive) setDown(true);
        return;
      }
      engine.current = module;
      return module.mountAsync(host.current!, latest.current, OPTIONS);
    }).then((diagram) => {
      if (!diagram) return;
      if (!alive) {
        diagram.destroy();
        return;
      }
      mounted.current = diagram;
      push(latest.current);
    });
    return () => {
      alive = false;
      mounted.current?.destroy();
      mounted.current = null;
    };
  }, []);

  // Edits after the mount flows through push; before it, `latest` carries
  // them into the initial render.
  useEffect(() => {
    push(text);
  }, [text]);

  return (
    <div className="mermaid" role="region" tabIndex={0} aria-label="Mermaid diagram" contentEditable={false}>
      <div ref={host} className="mermaid__host" />
      {down ? <p className="mermaid__hint">Diagram engine unavailable — showing source only.</p> : null}
    </div>
  );
});
