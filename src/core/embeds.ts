import type { Embed, PostEmbed, PostMedia, VideoEmbed } from "./types";

/* Links that become a card, as Notion embeds them (Winston, round 65): a
   YouTube video, played in YouTube's privacy-enhanced player, and a post on
   X, drawn by Notes — compact, its pictures small (round 66) — from what X
   gives out about it. A card is recognised from its address alone; its
   words, and where its pictures are, are read by the Lego brick Terminus
   publishes for it — the built-in service @terminus/web-card-preview
   (round 67), which reads the providers — for
   whoever made the card, checked here, and stored beside the address. A
   post's pictures are then fetched by each reader through the platform,
   never from X's host by the page itself.

   How an address, a stored card or a provider's answer can be wrong — a
   card is written by another member's client, an older one or the agent,
   and its words by a page on the web:
    1. a host that only resembles YouTube's or X's (youtube.com.evil.test,
       notyoutube.com, a userinfo "x.com@evil.test") → no card;
    2. a scheme other than http(s) → no card;
    3. a video id that is not exactly eleven of [A-Za-z0-9_-] → no card, so
       nothing can ride into the player's or the picture's address;
    4. every shape of YouTube's is read — watch?v=, youtu.be/, shorts/,
       embed/, live/, the m. and music. hosts, youtube-nocookie.com — and a
       channel, a playlist without a video or the home page → no card;
    5. a start time — t=90, 90s, 1m30s, 1h2m3s, start= — becomes seconds;
       anything else, zero, or past a day is no start;
    6. X's shapes — x.com, twitter.com, their www. and mobile. hosts, a post
       with /photo/1 or ?s=20 after it — are one canonical address; a handle
       outside [A-Za-z0-9_]{1,15}, a reserved path (home, search, i…) or an
       id that is not 1–19 digits → no card;
    7. a stored card is what its stored address says: the provider, the ids
       and the canonical address are read from it again, never trusted; an
       address that is no card → no card;
    8. stored words (a title, a name, a post's text, a date) that are not
       strings are dropped; control and direction-override characters are
       taken out; each is held to its length, a post's text keeping its line
       breaks and nothing else;
    9. a brick's answer is data too: kept only as a stored card is kept
       (7, 8, 10–13 hold for it) — a video's card keeps its own address and
       start; a post's answer that names another post adds nothing; an
       answer saying the video or post is gone (`missing`) adds nothing but
       `read`; one that is neither found nor missing (`unavailable`, not an
       answer, no answer) keeps nothing, so the card is asked about again;
   10. X's stand-in for a post's pictures and videos — the
       "pic.twitter.com/…" (or "pic.x.com/…") it puts among the words — is
       not words: it is dropped from a stored card, and the words around it
       keep their spaces and lines;
   11. when a post was made is a time or nothing — read again as one exact
       instant, shown in the reader's own zone, never pinned to one;
   12. a picture is on X's picture host alone — https://pbs.twimg.com/, a
       post's media, a video's or GIF's still, or a profile picture, a plain
       path with an image's extension: another host, a query, a "..", a
       path of any other shape → no picture; at most four are kept, sizes
       are whole positive numbers or none, a kind is photo, video or gif;
   13. a post X marks as possibly sensitive keeps no pictures to show: it
       says it is sensitive (`sensitive`), and a stored card saying so
       shows none of the pictures it may still hold. */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const POST_ID = /^[0-9]{1,19}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtube-nocookie.com", "www.youtube-nocookie.com",
]);
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
/** First path segments of X's own pages, never a person's handle. */
const X_PAGES = new Set(["home", "explore", "search", "i", "settings", "notifications", "messages", "compose", "hashtag", "intent", "share", "login", "signup", "tos", "privacy"]);

const DAY = 24 * 60 * 60;
const LIMITS = { title: 200, author: 100, name: 100, text: 1000, date: 40 } as const;

/** A start time as seconds: "90", "90s", "1m30s", "1h2m3s". */
function startSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  let seconds: number;
  if (/^[0-9]{1,6}$/.test(value)) {
    seconds = Number(value);
  } else {
    const parts = /^(?:([0-9]{1,2})h)?(?:([0-9]{1,4})m)?(?:([0-9]{1,6})s)?$/.exec(value);
    if (!parts || (!parts[1] && !parts[2] && !parts[3])) return undefined;
    seconds = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  }
  return seconds > 0 && seconds <= DAY ? seconds : undefined;
}

function video(url: URL, host: string): VideoEmbed | null {
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let vertical = false;
  if (host === "youtu.be") id = parts[0];
  else if (parts[0] === "watch" && parts.length === 1) id = url.searchParams.get("v") ?? undefined;
  else if (parts[0] === "shorts") {
    id = parts[1];
    vertical = true;
  } else if (parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") id = parts[1];
  if (!id || !VIDEO_ID.test(id)) return null;
  const start = startSeconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
  const address = vertical
    ? `https://www.youtube.com/shorts/${id}`
    : `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}`;
  return {
    provider: "youtube",
    url: address,
    video_id: id,
    ...(start ? { start } : {}),
    ...(vertical ? { vertical: true } : {}),
  };
}

function post(url: URL): PostEmbed | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || (parts[1] !== "status" && parts[1] !== "statuses")) return null;
  const [handle, , id] = parts;
  if (!HANDLE.test(handle) || X_PAGES.has(handle.toLowerCase()) || !POST_ID.test(id)) return null;
  return { provider: "x", url: `https://x.com/${handle}/status/${id}`, handle, post_id: id };
}

/** The card a link makes, if it makes one: a YouTube video or a post on X,
 *  at its canonical address. */
export function embedFromUrl(address: unknown): Embed | null {
  if (typeof address !== "string") return null;
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be" || YOUTUBE_HOSTS.has(host)) return video(url, host);
  if (X_HOSTS.has(host)) return post(url);
  return null;
}

/* Control characters (a line break is kept where lines are), and the ones
   that reorder the text around them — by number, never typed. */
const STRIPPED = new Set<number>([
  ...Array.from({ length: 0x09 }, (_, index) => index),
  ...Array.from({ length: 0x20 - 0x0b }, (_, index) => 0x0b + index),
  ...Array.from({ length: 0xa0 - 0x7f }, (_, index) => 0x7f + index),
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

/** Plain, bounded words: one line, or — `lines` — lines kept (at most one
 *  blank line between them). Empty when nothing is left. */
function cleanWords(value: unknown, max: number, lines = false): string {
  if (typeof value !== "string") return "";
  let words = "";
  for (const character of value.replace(/\r\n?/g, "\n")) {
    words += STRIPPED.has(character.codePointAt(0) ?? 0) ? " " : character;
  }
  words = lines
    ? words.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    : words.replace(/\s+/g, " ").trim();
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}

function field<K extends string>(key: K, value: unknown, max: number, lines = false): Partial<Record<K, string>> {
  const words = cleanWords(value, max, lines);
  return words ? { [key]: words } as Record<K, string> : {};
}

/** A stored card, as its stored address says it is (the ids read from the
 *  address again) with its words checked. */
export function normalizeEmbed(value: unknown): Embed | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const base = embedFromUrl(record.url);
  if (!base) return null;
  const read = record.read === true ? { read: true as const } : {};
  if (base.provider === "youtube") {
    return { ...base, ...field("title", record.title, LIMITS.title), ...field("author", record.author, LIMITS.author), ...read };
  }
  const sensitive = record.sensitive === true;
  const posted = postTime(record.posted);
  const avatar = picture(record.avatar, "avatar");
  const media = sensitive ? undefined : mediaList(record.media);
  return {
    ...base,
    ...field("name", record.name, LIMITS.name),
    ...field("text", withoutMediaStandIns(record.text), LIMITS.text, true),
    ...field("date", record.date, LIMITS.date),
    ...(posted ? { posted } : {}),
    ...(avatar ? { avatar } : {}),
    ...(media ? { media } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    ...read,
  };
}

/** A picture on X's picture host: a post's media or a video's or GIF's
 *  still (`media`), or a profile picture (`avatar`) — a plain path with an
 *  image's extension, nothing else. */
const PICTURE = /^https:\/\/pbs\.twimg\.com\/(media|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb|profile_images)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:jpg|jpeg|png|webp|gif)$/;
const MEDIA_KINDS: ReadonlySet<string> = new Set(["photo", "video", "gif"]);
const MOST_MEDIA = 4;

function picture(value: unknown, as: "media" | "avatar"): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  const found = PICTURE.exec(value);
  if (!found) return undefined;
  return (found[1] === "profile_images") === (as === "avatar") ? value : undefined;
}

/** A whole positive number, or nothing. */
function whole(value: unknown, most = 100000): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= most ? value : undefined;
}

function mediaItem(kind: unknown, url: unknown, width: unknown, height: unknown): PostMedia | null {
  const address = picture(url, "media");
  if (typeof kind !== "string" || !MEDIA_KINDS.has(kind) || !address) return null;
  const across = whole(width);
  const down = whole(height);
  return { kind: kind as PostMedia["kind"], url: address, ...(across && down ? { width: across, height: down } : {}) };
}

/** A stored card's pictures: at most four, each checked. */
function mediaList(value: unknown): PostMedia[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: PostMedia[] = [];
  for (const item of value) {
    if (kept.length === MOST_MEDIA) break;
    if (!item || typeof item !== "object") continue;
    const { kind, url, width, height } = item as Record<string, unknown>;
    const found = mediaItem(kind, url, width, height);
    if (found) kept.push(found);
  }
  return kept.length ? kept : undefined;
}

/** X's stand-in for a post's pictures and videos, among its words. */
const MEDIA_STAND_IN = /(^|\s)pic\.(?:twitter|x)\.com\/[A-Za-z0-9]+(?=\s|$)/gi;

/** A post's words without X's stand-ins for its pictures and videos. */
function withoutMediaStandIns(words: unknown): unknown {
  return typeof words === "string" ? words.replace(MEDIA_STAND_IN, "$1") : words;
}

/** When a post was made, as one exact time (ISO), or nothing: the reader's
 *  own zone says what day that was. */
function postTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** A card with what its brick answered (9), its words under the provider's
 *  name (`youtube` or `x`), checked as a stored card is; null when there is
 *  nothing to keep yet. */
export function withCardAnswer(embed: Embed, answer: unknown): Embed | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const card = answer as Record<string, unknown>;
  if (card.status === "missing") return { ...embed, read: true };
  if (card.status !== "found") return null;
  if (embed.provider === "youtube") {
    const video = card.youtube && typeof card.youtube === "object" ? card.youtube as Record<string, unknown> : {};
    return normalizeEmbed({ url: embed.url, title: video.title, author: video.author, read: true }) ?? { ...embed, read: true };
  }
  const shown = card.x && typeof card.x === "object" ? card.x as Record<string, unknown> : {};
  const post = shown.post && typeof shown.post === "object" ? shown.post as Record<string, unknown> : {};
  const answered = embedFromUrl(post.url);
  if (answered?.provider !== "x" || answered.post_id !== embed.post_id) return { ...embed, read: true };
  return normalizeEmbed({
    url: answered.url,
    name: shown.name,
    text: shown.text,
    date: shown.date,
    posted: shown.posted,
    avatar: shown.avatar,
    media: shown.media,
    sensitive: shown.sensitive,
    read: true,
  }) ?? { ...embed, read: true };
}

/** A small picture (at most 240px on a side) of a post's picture, from the
 *  same host; a profile picture is small already. */
export function postPictureAddress(url: string): string {
  const found = /^(https:\/\/pbs\.twimg\.com\/.+)\.(jpg|jpeg|png|webp|gif)$/.exec(url);
  if (!found || url.startsWith("https://pbs.twimg.com/profile_images/")) return url;
  return `${found[1]}?format=${found[2] === "jpeg" ? "jpg" : found[2]}&name=240x240`;
}

/** YouTube's privacy-enhanced player for a video, playing at once (it is
 *  opened by a press on its picture), from where the link started it. */
export function videoPlayerAddress(embed: VideoEmbed): string {
  const query = new URLSearchParams({ autoplay: "1", rel: "0" });
  if (embed.start) query.set("start", String(embed.start));
  return `https://www.youtube-nocookie.com/embed/${embed.video_id}?${query}`;
}

/** The video's own still, as YouTube serves it. */
export function videoPictureAddress(embed: VideoEmbed): string {
  return `https://i.ytimg.com/vi/${embed.video_id}/hqdefault.jpg`;
}

/** What turning a link into its card is called. */
export function embedVerb(embed: Embed): string {
  return embed.provider === "youtube" ? "Embed video" : "Embed post";
}
