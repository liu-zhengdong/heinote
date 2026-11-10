import { EyeOff, ExternalLink, MoreHorizontal, Play } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { normalizeImageWidth } from "../../core/files";
import { normalizeEmbed, postPictureAddress, videoPictureAddress, videoPlayerAddress } from "../../core/embeds";
import type { Block, Embed, PostEmbed, PostMedia, VideoEmbed } from "../../core/types";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { publicPicture } from "./embed-details";
import { dragEdge } from "./MediaBlocks";

/** What a card asks of its editor. */
export interface EmbedActions {
  /** A card whose provider has not been asked yet: ask, and keep the answer. */
  readEmbed(block: Block): void;
  /** The card's ··· — its paragraph menu, as ⌘/ opens it. */
  openBlockMenu(block: Block, anchor: AnchorRect): void;
  /** The card dragged to a width by its edges; `undefined` is its own size. */
  resizeCard(block: Block, width: number | undefined): void;
}

/* How wide a card may be dragged, as Notion's are: a video from 200px to its
   column (its own size), a short from 160px to 560px (its own, 320px), and a
   post from 250px to its column (its own, 550px — wider than it is tall). */
const SIZES = {
  video: { least: 200, natural: (column: number) => column },
  short: { least: 160, most: 560, natural: () => 320 },
  post: { least: 250, natural: () => 550 },
} as const;

/** X's mark, as its posts wear it. */
function XMark() {
  return (
    <svg className="embed__x" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** YouTube's play button. */
function PlayButton() {
  return (
    <svg className="embed__play" viewBox="0 0 68 48" aria-hidden="true">
      <path className="embed__play-shape" d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" />
      <path fill="#fff" d="M45 24 27 14v20" />
    </svg>
  );
}

/** A card's tools, on approach, as an image's are: the original, and — for
 *  someone who may change the page — the card's menu. */
function EmbedTools({ embed, block, readOnly, actions }: { embed: Embed; block: Block; readOnly: boolean; actions: EmbedActions }) {
  const where = embed.provider === "youtube" ? "Open on YouTube" : "Open on X";
  return (
    <div className="embed__tools">
      <a className="block__image-tool" href={embed.url} target="_blank" rel="noopener noreferrer" aria-label={where} title={where}>
        <ExternalLink size={14} />
      </a>
      {readOnly ? null : (
        <button
          type="button"
          className="block__image-tool"
          aria-label="Card actions"
          onClick={(event) => actions.openBlockMenu(block, rectOf(event.currentTarget))}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    </div>
  );
}

/** Notion's two handles on a card's sides, as a picture has them, for
 *  someone who may change the page. */
function EdgeHandles({ figure, size, block, actions }: {
  figure: RefObject<HTMLElement | null>;
  size: (typeof SIZES)[keyof typeof SIZES];
  block: Block;
  actions: EmbedActions;
}) {
  const drag = (side: "left" | "right") => (event: ReactPointerEvent<HTMLElement>) =>
    dragEdge(event, side, figure.current, { ...size, done: (width) => actions.resizeCard(block, width) });
  return (
    <>
      <span className="block__resize block__resize--left" aria-hidden="true" onPointerDown={drag("left")} />
      <span className="block__resize block__resize--right" aria-hidden="true" onPointerDown={drag("right")} />
    </>
  );
}

/** A video: its still with YouTube's play button until it is pressed, then
 *  YouTube's privacy-enhanced player in its place, playing — nothing of
 *  YouTube's is loaded for a video nobody plays. */
function VideoCard({ embed, block, width, readOnly, actions }: { embed: VideoEmbed; block: Block; width?: number; readOnly: boolean; actions: EmbedActions }) {
  const [playing, setPlaying] = useState(false);
  const figure = useRef<HTMLElement | null>(null);
  const still = usePublicPicture(videoPictureAddress(embed));
  const title = embed.title || "YouTube video";
  return (
    <figure
      ref={figure}
      className={`embed embed--video ${embed.vertical ? "is-vertical" : ""}`}
      contentEditable={false}
      style={width ? { width: `${width}px` } : undefined}
    >
      <div className="embed__frame">
        {playing ? (
          <iframe
            src={videoPlayerAddress(embed)}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" className="embed__still" aria-label={`Play ${title}`} onClick={() => setPlaying(true)}>
            {still ? <img src={still} alt="" draggable={false} /> : null}
            {embed.title ? (
              <span className="embed__heading">
                <span className="embed__title">{embed.title}</span>
                {embed.author ? <span className="embed__author">{embed.author}</span> : null}
              </span>
            ) : null}
            <PlayButton />
          </button>
        )}
        {readOnly ? null : <EdgeHandles figure={figure} size={embed.vertical ? SIZES.short : SIZES.video} block={block} actions={actions} />}
        <EmbedTools embed={embed} block={block} readOnly={readOnly} actions={actions} />
      </div>
    </figure>
  );
}

/** A picture from the web — a video's still, a post's picture — through the
 *  web service: null until it has come, or when it cannot. */
function usePublicPicture(url: string | undefined): string | null {
  const [shown, setShown] = useState<{ url?: string; src: string | null }>({ src: null });
  useEffect(() => {
    if (!url) return;
    let live = true;
    void publicPicture(url).then((src) => {
      if (live) setShown({ url, src });
    });
    return () => {
      live = false;
    };
  }, [url]);
  return url && shown.url === url ? shown.src : null;
}

/** When a post was made, as the reader's own calendar says: "Sep 28, 2026". */
function postedDay(posted: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(posted));
}

/** "2 pictures and a video", for a post's pictures. */
function mediaLabel(media: PostMedia[]): string {
  const photos = media.filter((item) => item.kind === "photo").length;
  const moving = media.length - photos;
  return [
    photos ? `${photos} ${photos === 1 ? "picture" : "pictures"}` : "",
    moving ? `${moving === 1 ? "a video" : `${moving} videos`}` : "",
  ].filter(Boolean).join(" and ");
}

function PostMediaCell({ item }: { item: PostMedia }) {
  const src = usePublicPicture(postPictureAddress(item.url));
  return (
    <span className="embed__media-cell" data-kind={item.kind}>
      {src ? <img src={src} alt="" draggable={false} /> : null}
      {item.kind === "video" ? <span className="embed__media-play" aria-hidden="true"><Play size={12} fill="currentColor" /></span> : null}
      {item.kind === "gif" ? <span className="embed__media-badge" aria-hidden="true">GIF</span> : null}
    </span>
  );
}

/** A post's pictures, small, at the card's side — up to four in a square,
 *  as X lays them out; a video's or a GIF's still marked as one. A post X
 *  marks as sensitive shows that instead, and fetches nothing. */
function PostMediaGrid({ embed }: { embed: PostEmbed }) {
  if (embed.sensitive) {
    return (
      <span className="embed__media is-sensitive" role="img" aria-label="Sensitive media">
        <EyeOff size={16} aria-hidden="true" />
        <span>Sensitive</span>
      </span>
    );
  }
  const media = embed.media ?? [];
  if (!media.length) return null;
  return (
    <span className="embed__media" data-count={media.length} role="img" aria-label={mediaLabel(media)}>
      {media.map((item) => <PostMediaCell key={item.url} item={item} />)}
    </span>
  );
}

/** A post, drawn by Notes as compact as Notion's bookmark (Winston, round
 *  66: "the width is bigger than height; the image and videos inside should
 *  be small; also, make it more compact"): its author on one line, its
 *  words beside its pictures, and nothing to press but the card itself,
 *  which opens the post on X. */
function PostCard({ embed, block, width, readOnly, actions }: { embed: PostEmbed; block: Block; width?: number; readOnly: boolean; actions: EmbedActions }) {
  const figure = useRef<HTMLElement | null>(null);
  const avatar = usePublicPicture(embed.avatar);
  const day = embed.posted ? postedDay(embed.posted) : embed.date;
  return (
    <figure
      ref={figure}
      className="embed embed--post"
      contentEditable={false}
      style={width ? { width: `${Math.max(width, SIZES.post.least)}px` } : undefined}
    >
      <a className="embed__post" href={embed.url} target="_blank" rel="noopener noreferrer">
        <span className="embed__post-body">
          <span className="embed__post-head">
            {avatar ? <img className="embed__avatar" src={avatar} alt="" draggable={false} /> : <span className="embed__avatar" aria-hidden="true" />}
            <span className="embed__who">
              {embed.name ? <span className="embed__name">{embed.name}</span> : null}
              <span className="embed__handle">@{embed.handle}</span>
              {day ? <span className="embed__date">{day}</span> : null}
            </span>
            <XMark />
          </span>
          {embed.text
            ? <span className="embed__text">{embed.text}</span>
            : <span className="embed__text is-quiet">{embed.read ? "This post can’t be shown here." : "A post on X"}</span>}
        </span>
        <PostMediaGrid embed={embed} />
      </a>
      {readOnly ? null : <EdgeHandles figure={figure} size={SIZES.post} block={block} actions={actions} />}
      <EmbedTools embed={embed} block={block} readOnly={readOnly} actions={actions} />
    </figure>
  );
}

/** A link shown as a card, as Notion embeds one: a YouTube video or a post
 *  on X, at the width it was dragged to (its own, until then). A card
 *  nobody has asked the provider about yet is asked about by the first
 *  person who may change the page to see it. */
export function EmbedBlock({ block, readOnly, actions }: { block: Block; readOnly: boolean; actions: EmbedActions }) {
  const embed = normalizeEmbed(block.embed);
  const unread = Boolean(embed && !embed.read);
  useEffect(() => {
    if (unread && !readOnly) actions.readEmbed(block);
    // Asked again only when the card, or whether it has been read, changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embed?.url, unread, readOnly]);
  if (!embed) return <p className="embed embed--broken" contentEditable={false}>This card’s link can’t be shown.</p>;
  const width = normalizeImageWidth(block.width);
  return embed.provider === "youtube"
    ? <VideoCard embed={embed} block={block} width={width} readOnly={readOnly} actions={actions} />
    : <PostCard embed={embed} block={block} width={width} readOnly={readOnly} actions={actions} />;
}
