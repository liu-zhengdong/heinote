import { ArrowRight, ChevronLeft, ChevronRight, Download, Eraser, Expand, PenLine, Square, Type, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { StoredFile } from "../../core/types";
import { Modal } from "../../components/Modal";
import { useFileUrl, type MediaActions } from "./MediaBlocks";

/* A picture looked through in turn — a cell's: where this one stands among
   the pictures, and the steps either side of it. */
export interface ViewerBrowse {
  count: number;
  index: number;
  onStep(step: number): void;
}

/* The stage is the viewer's room. The frame inside it holds the picture and
   the marks made on it at one scale: `zoom` counts 1 as the picture's own
   pixels, `pan` holds the frame's corner inside the stage — so the marks
   are the picture's, and every view of them follows the same transform. */
interface Point { x: number; y: number }

type Tool = "pen" | "arrow" | "rect" | "text";

interface Stroke {
  tool: Tool;
  color: string;
  /** The line's weight as a share of the picture's shorter side, so a mark
   *  stays the same thickness on the picture at every zoom. */
  weight: number;
  /** Points in the picture's own coordinates — a share of its width and
   *  height, never of the screen's. */
  points: Point[];
  text?: string;
  /** The letters' height as a share of the picture's height. */
  size?: number;
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
/** A mark's weight defaults to about four pixels on a thousand-pixel
 *  picture — thin enough to point with, thick enough to read. */
const STROKE_WEIGHT = 0.004;
const TEXT_SIZE = 0.035;
const COLORS = ["#f03e3e", "#fab005", "#40c057", "#228be6", "#ffffff"];

const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** The frame kept inside the stage: a picture no bigger than its room
 *  centres itself; a bigger one slides but keeps a strip under the pointer's
 *  reach, never escaping whole. */
function clampPan(pan: Point, stage: DOMRect | null, width: number, height: number, zoom: number): Point {
  if (!stage) return pan;
  const w = width * zoom;
  const h = height * zoom;
  return {
    x: w <= stage.width ? (stage.width - w) / 2 : Math.min(0, Math.max(stage.width - w, pan.x)),
    y: h <= stage.height ? (stage.height - h) / 2 : Math.min(0, Math.max(stage.height - h, pan.y)),
  };
}

/** A pointer's place on the picture — the marks' own coordinates. */
function imagePoint(clientX: number, clientY: number, stage: DOMRect, pan: Point, width: number, height: number, zoom: number): Point {
  return {
    x: (clientX - stage.left - pan.x) / (width * zoom),
    y: (clientY - stage.top - pan.y) / (height * zoom),
  };
}

function drawStrokes(canvas: HTMLCanvasElement, width: number, height: number, strokes: readonly Stroke[], draft: Stroke | null) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  /* The canvas backing is device pixels, the marks' math is in the shown
     picture's CSS pixels — the transform between them is the density's, so
     a mark lands where the pointer did on screens of every density. */
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  /* Everything drawn is in screen pixels of the shown picture: a mark's
     place is its picture share times the shown size, its weight the same. */
  const spot = (point: Point) => ({ x: point.x * w, y: point.y * h });
  for (const stroke of draft ? [...strokes, draft] : strokes) {
    const weight = stroke.weight * Math.min(w, h);
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = weight;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const points = stroke.points.map(spot);
    if (stroke.tool === "pen" && points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    } else if (stroke.tool === "arrow" && points.length > 1) {
      const [from, to] = [points[0], points[points.length - 1]];
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = Math.max(10, weight * 4);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (stroke.tool === "rect" && points.length > 1) {
      const [from, to] = [points[0], points[points.length - 1]];
      ctx.strokeRect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    } else if (stroke.tool === "text" && stroke.text && points.length) {
      const size = Math.max(10, (stroke.size ?? TEXT_SIZE) * h);
      ctx.font = `600 ${size}px sans-serif`;
      ctx.textBaseline = "top";
      const start = points[0];
      ctx.fillText(stroke.text, start.x, start.y);
    }
  }
}

export function ImageViewer({
  file,
  browse,
  actions,
  onDownload,
  onClose,
}: {
  file: StoredFile;
  browse?: ViewerBrowse;
  actions: Pick<MediaActions, "showFile">;
  onDownload?: () => void;
  onClose(): void;
}) {
  const { url, failed, retry } = useFileUrl(file, "original", actions);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** The picture's own pixels; the view's zoom counts from them. */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [textSpot, setTextSpot] = useState<Point | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const panFrom = useRef<{ start: Point; at: Point } | null>(null);
  const drawFrom = useRef<Stroke | null>(null);

  const annotating = tool !== null;
  const first = !browse || browse.index <= 0;
  const last = !browse || browse.index >= browse.count - 1;

  const stageRect = () => stageRef.current?.getBoundingClientRect() ?? null;

  /** The shown picture's screen pixels under the current zoom. */
  const shown = natural ? { w: natural.w * zoom, h: natural.h * zoom } : null;

  /** A picture arriving settles to its fit: as large as the room allows,
   *  never bigger than its own pixels. Everything it wore is gone with it. */
  const fit = useCallback((image: { w: number; h: number }) => {
    const stage = stageRect();
    if (!stage || !image.w || !image.h) return;
    const scale = Math.min(1, stage.width / image.w, stage.height / image.h);
    setZoom(scale);
    setPan({ x: (stage.width - image.w * scale) / 2, y: (stage.height - image.h * scale) / 2 });
    setTool(null);
    setStrokes([]);
    setDraft(null);
    setTextSpot(null);
  }, []);

  /** A step to another picture is a new room: clean marks, fresh fit. */
  useEffect(() => {
    setNatural(null);
  }, [file]);

  /* Keep the picture in reach when the stage itself changes size. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      setPan((current) => natural ? clampPan(current, stageRect(), natural.w, natural.h, zoom) : current);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [natural, zoom]);

  /* Marks redrawn when they change, or when the shown size does. */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && shown) drawStrokes(canvas, shown.w, shown.h, strokes, draft);
  }, [shown?.w, shown?.h, strokes, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (textSpot) textRef.current?.focus();
  }, [textSpot]);

  /** Zoom about a spot on the stage: the wheel's under the pointer, the
   *  buttons' at the room's centre. What the pointer rests on stays put. */
  const zoomTo = useCallback((next: number, anchor?: Point) => {
    if (!natural) return;
    const stage = stageRect();
    if (!stage) return;
    const clamped = clampZoom(next);
    const at = anchor ?? { x: stage.width / 2, y: stage.height / 2 };
    setZoom(clamped);
    setPan((pan) => clampPan({
      x: at.x - (at.x - pan.x) * (clamped / zoom),
      y: at.y - (at.y - pan.y) * (clamped / zoom),
    }, stage, natural.w, natural.h, clamped));
  }, [natural, zoom]);

  /** A double click trades fit for full size and back. */
  const zoomToggle = useCallback((event: { clientX: number; clientY: number }) => {
    if (!natural) return;
    const stage = stageRect();
    if (!stage) return;
    const fitScale = Math.min(1, stage.width / natural.w, stage.height / natural.h);
    const at = { x: event.clientX - stage.left, y: event.clientY - stage.top };
    zoomTo(Math.abs(zoom - 1) < 0.01 ? fitScale : 1, at);
  }, [natural, zoom, zoomTo]);

  /** The wheel zooms; when the picture is still small it grows toward the
   *  pointer, when large the room lets it pass under the pointer. */
  const onWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const stage = stageRect();
    if (!stage || !natural) return;
    const at = { x: event.clientX - stage.left, y: event.clientY - stage.top };
    const next = clampZoom(zoom * Math.exp(-event.deltaY * 0.0015));
    setZoom(next);
    setPan((pan) => clampPan({
      x: at.x - (at.x - pan.x) * (next / zoom),
      y: at.y - (at.y - pan.y) * (next / zoom),
    }, stage, natural.w, natural.h, next));
  }, [natural, zoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  /* Keys: +/−/0 zoom as the buttons do; arrows keep their picture steps —
     taken in capture so the editor under the dialog hears none of them. */
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      const handled =
        event.key === "+" || event.key === "=" ? (zoomTo(zoom * 1.25), true) :
        event.key === "-" ? (zoomTo(zoom / 1.25), true) :
        event.key === "0" ? (natural && fit(natural), true) :
        event.key === "ArrowLeft" && !first ? (browse!.onStep(-1), true) :
        event.key === "ArrowRight" && !last ? (browse!.onStep(1), true) : false;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [zoom, zoomTo, natural, fit, first, last, browse]);

  /* Escape reaches this room through the dialog's own onClose: marks it
     holds are left behind first — the dialog's close is asked, not taken. */
  const requestClose = annotating ? () => setTool(null) : onClose;

  /* ── Browse gestures: a held picture pans, a picture that fits stays ── */

  const grab = (event: ReactPointerEvent<HTMLElement>) => {
    if (annotating || event.button !== 0) return;
    const stage = stageRect();
    if (!stage || !shown) return;
    if (shown.w <= stage.width && shown.h <= stage.height) return;
    event.preventDefault();
    panFrom.current = { start: { x: event.clientX, y: event.clientY }, at: pan };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };

  const dragging = (event: ReactPointerEvent<HTMLElement>) => {
    if (panFrom.current && shown) {
      setPan(clampPan({
        x: panFrom.current.at.x + (event.clientX - panFrom.current.start.x),
        y: panFrom.current.at.y + (event.clientY - panFrom.current.start.y),
      }, stageRect(), natural!.w, natural!.h, zoom));
      return;
    }
    if (!drawFrom.current || !natural) return;
    const stage = stageRect();
    if (!stage) return;
    const point = imagePoint(event.clientX, event.clientY, stage, pan, natural.w, natural.h, zoom);
    /* A pen keeps every step of the path; shapes keep their two corners. */
    drawFrom.current = {
      ...drawFrom.current,
      points: drawFrom.current.tool === "pen" ? [...drawFrom.current.points, point] : [drawFrom.current.points[0], point],
    };
    setDraft(drawFrom.current);
  };

  const release = () => {
    panFrom.current = null;
    setPanning(false);
    if (drawFrom.current) {
      const done = draft;
      if (done && done.points.length > 1) setStrokes((all) => [...all, done]);
      drawFrom.current = null;
      setDraft(null);
    }
  };

  /* ── Marking gestures: the canvas takes the pointer in annotate mode ── */

  const beginMark = (event: ReactPointerEvent<HTMLElement>) => {
    if (!tool || !natural || event.button !== 0) return;
    const stage = stageRect();
    if (!stage) return;
    event.preventDefault();
    const point = imagePoint(event.clientX, event.clientY, stage, pan, natural.w, natural.h, zoom);
    if (tool === "text") {
      setTextSpot(point);
      setTextDraft("");
      return;
    }
    drawFrom.current = { tool, color, weight: STROKE_WEIGHT, points: [point] };
    setDraft(drawFrom.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const commitText = () => {
    if (textSpot && textDraft.trim()) {
      setStrokes((all) => [...all, { tool: "text", color, weight: STROKE_WEIGHT, points: [textSpot], text: textDraft.trim(), size: TEXT_SIZE }]);
    }
    setTextSpot(null);
    setTextDraft("");
  };

  /* A text mark lands where it was pointed: its room's place is the
     picture's share carried through the same transform. */
  const textBoxPlace = () => {
    if (!textSpot || !natural) return null;
    return { left: pan.x + textSpot.x * natural.w * zoom, top: pan.y + textSpot.y * natural.h * zoom };
  };

  return (
    <Modal open label={file.name} className="viewer" onClose={requestClose}>
      <div className="viewer__bar">
        <span className="viewer__name">{file.name}</span>
        {browse && browse.count > 1 ? <span className="viewer__count">{browse.index + 1} of {browse.count}</span> : null}
        {url ? (
          <>
            <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomTo(zoom / 1.25)}>
              <ZoomOut size={15} />
            </button>
            <span className="viewer__zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomTo(zoom * 1.25)}>
              <ZoomIn size={15} />
            </button>
            <button type="button" className="icon-btn" aria-label="Fit to window" title="Fit to window (0)" onClick={() => natural && fit(natural)}>
              <Expand size={15} />
            </button>
            <button
              type="button"
              className={`icon-btn ${annotating ? "is-on" : ""}`}
              aria-label="Annotate"
              aria-pressed={annotating}
              title="Annotate"
              onClick={() => setTool(annotating ? null : "pen")}
            >
              <PenLine size={15} />
            </button>
          </>
        ) : null}
        {onDownload ? (
          <button type="button" className="icon-btn" aria-label="Download" onClick={onDownload}>
            <Download size={15} />
          </button>
        ) : null}
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {annotating ? (
        <div className="viewer__tools" role="toolbar" aria-label="Annotate tools">
          {(["pen", "arrow", "rect", "text"] as const).map((name) => (
            <button
              key={name}
              type="button"
              className={`icon-btn ${tool === name ? "is-on" : ""}`}
              aria-label={`${name} tool`}
              aria-pressed={tool === name}
              onClick={() => { setTool(name); setTextSpot(null); }}
            >
              {name === "pen" ? <PenLine size={15} /> : name === "arrow" ? <ArrowRight size={15} /> : name === "rect" ? <Square size={15} /> : <Type size={15} />}
            </button>
          ))}
          <span className="viewer__tools-sep" />
          {COLORS.map((paint) => (
            <button
              key={paint}
              type="button"
              className={`viewer__swatch ${color === paint ? "is-on" : ""}`}
              style={{ background: paint }}
              aria-label={`Color ${paint}`}
              aria-pressed={color === paint}
              onClick={() => setColor(paint)}
            />
          ))}
          <span className="viewer__tools-sep" />
          <button type="button" className="icon-btn" aria-label="Undo" title="Undo" disabled={!strokes.length && !draft} onClick={() => setStrokes((all) => all.slice(0, -1))}>
            <Undo2 size={15} />
          </button>
          <button type="button" className="icon-btn" aria-label="Clear marks" title="Clear marks" disabled={!strokes.length} onClick={() => { setStrokes([]); setDraft(null); }}>
            <Eraser size={15} />
          </button>
        </div>
      ) : null}
      <div
        ref={stageRef}
        className={`viewer__stage ${annotating ? "is-annotating" : ""} ${panning ? "is-panning" : ""}`}
        onClick={annotating ? undefined : requestClose}
      >
        {url ? (
          <div
            className="viewer__frame"
            style={shown ? {
              width: shown.w,
              height: shown.h,
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
            } : undefined}
            onPointerDown={annotating ? beginMark : grab}
            onPointerMove={dragging}
            onPointerUp={release}
            onPointerCancel={release}
            onClick={annotating ? undefined : (event) => event.stopPropagation()}
          >
            <img
              src={url}
              alt={file.name}
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget;
                if (!natural) {
                  setNatural({ w: image.naturalWidth, h: image.naturalHeight });
                  fit({ w: image.naturalWidth, h: image.naturalHeight });
                }
              }}
              onDoubleClick={annotating ? undefined : zoomToggle}
            />
            <canvas ref={canvasRef} className="viewer__marks" />
          </div>
        ) : (
          failed ? (
            <div className="viewer__missing">
              <p>This image could not be loaded.</p>
              <button type="button" onClick={(event) => { event.stopPropagation(); retry(); }}>Retry</button>
            </div>
          ) : (
            <div className="spinner" aria-label="Loading" />
          )
        )}
        {textSpot && textBoxPlace() ? (
          <textarea
            ref={textRef}
            className="viewer__text-spot"
            style={{ ...textBoxPlace(), color, fontSize: Math.max(12, TEXT_SIZE * shown!.h) }}
            value={textDraft}
            rows={1}
            placeholder="Text"
            onChange={(event) => setTextDraft(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitText(); } if (event.key === "Escape") { setTextSpot(null); setTextDraft(""); } }}
            onBlur={commitText}
            onClick={(event) => event.stopPropagation()}
          />
        ) : null}
        {browse && browse.count > 1 ? (
          <>
            <button
              type="button"
              className="viewer__step viewer__step--back"
              aria-label="Previous image"
              disabled={first}
              onClick={(event) => { event.stopPropagation(); browse.onStep(-1); }}
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              className="viewer__step viewer__step--next"
              aria-label="Next image"
              disabled={last}
              onClick={(event) => { event.stopPropagation(); browse.onStep(1); }}
            >
              <ChevronRight size={20} />
            </button>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
