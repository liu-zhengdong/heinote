import app from "../../../schema";
import { withCardAnswer } from "../../core/embeds";
import type { Embed } from "../../core/types";

/* A video card is YouTube's own player, behind the video's still. The app
   host lets every app's page frame YouTube's privacy-enhanced player
   (www.youtube-nocookie.com) and nothing else; the still, like a post's
   pictures, comes as bytes through the web service, so the page itself
   never asks another site for anything. */

/** The brick's answers this session, by video or post: an answer, or null
 *  when there was none to be had. Two cards of one video, started at
 *  different times, share it and keep their own addresses. */
const asked = new Map<string, Promise<unknown>>();

/** What Terminus's card brick says about a card — an official service,
 *  declared in schema.ts and called as any app calls a service, once a
 *  session per video or post. It reads the providers, so the provider never
 *  sees who reads the page. */
function ask(embed: Embed): Promise<unknown> {
  const key = embed.provider === "youtube" ? `video ${embed.video_id}` : `post ${embed.post_id}`;
  let reading = asked.get(key);
  if (!reading) {
    reading = app.cards.call("read", { url: embed.url }).catch(() => null);
    asked.set(key, reading);
  }
  return reading;
}

/** What a card's brick says about it: a video's title and channel; a post's
 *  author, words, date and pictures — checked as a stored card is. Null when
 *  there is nothing to keep yet (no answer, the brick or the provider busy):
 *  the card is asked about again another time. An answer that the video or
 *  post is gone is kept as read. */
export function readEmbedDetails(embed: Embed): Promise<Embed | null> {
  return ask(embed).then((answer) => withCardAnswer(embed, answer));
}

/** Pictures read this session, by address: an object URL, or null. */
const pictures = new Map<string, Promise<string | null>>();

/** The bytes the web service's `image` answered, as a Blob — or null for
 *  anything but a picture. */
function pictureOf(answer: { status: number; contentType: string; bodyBase64: string | null }): Blob | null {
  if (answer.status !== 200 || !answer.bodyBase64 || !/^image\//i.test(answer.contentType)) return null;
  const binary = atob(answer.bodyBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: answer.contentType });
}

/** A picture from the web — a video's still, a post's picture — as bytes
 *  through the web service: an app page cannot load another origin's
 *  picture, and should not: the site would see every reader. Read once a
 *  session; null when it cannot be. */
export function publicPicture(url: string): Promise<string | null> {
  let reading = pictures.get(url);
  if (!reading) {
    reading = app.web.request("image", { url })
      .then((answer) => {
        const picture = pictureOf(answer);
        return picture ? URL.createObjectURL(picture) : null;
      })
      .catch(() => null);
    pictures.set(url, reading);
  }
  return reading;
}
