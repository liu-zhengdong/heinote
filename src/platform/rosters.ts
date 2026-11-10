import type { SpaceRoster } from "../core/types";

type OpenRoster = (spaceId: string, listener: (roster: SpaceRoster) => void) => Promise<() => void>;

interface Followed {
  stop: (() => void) | null;
  closed: boolean;
}

/** The rosters of the spaces a member is in — who is there, and who has been
 *  asked in — each kept current by its own live feed: opened when its space
 *  joins the list, closed when it leaves it. A roster is read again only when
 *  its own space says it changed; a wake about another space, or the window
 *  coming back into focus, reads nothing. */
export class SpaceRosters {
  private readonly followed = new Map<string, Followed>();
  private rosters: Record<string, SpaceRoster> = {};

  constructor(
    private readonly open: OpenRoster,
    private readonly onChange: (rosters: Record<string, SpaceRoster>) => void,
  ) {}

  /** Follows exactly these spaces' rosters: the new ones open, the ones no
   *  longer named close and are forgotten. */
  follow(spaceIds: readonly string[]): void {
    const wanted = new Set(spaceIds);
    let dropped = false;
    for (const [spaceId, entry] of this.followed) {
      if (wanted.has(spaceId)) continue;
      entry.closed = true;
      entry.stop?.();
      this.followed.delete(spaceId);
      if (spaceId in this.rosters) {
        const { [spaceId]: _gone, ...rest } = this.rosters;
        this.rosters = rest;
        dropped = true;
      }
    }
    if (dropped) this.onChange(this.rosters);
    for (const spaceId of wanted) {
      if (this.followed.has(spaceId)) continue;
      const entry: Followed = { stop: null, closed: false };
      this.followed.set(spaceId, entry);
      this.open(spaceId, (roster) => {
        if (entry.closed) return;
        this.rosters = { ...this.rosters, [spaceId]: roster };
        this.onChange(this.rosters);
      }).then(
        (stop) => {
          if (entry.closed) stop();
          else entry.stop = stop;
        },
        () => {
          // Not readable now — left a moment ago, say: the next list that
          // still names the space tries again.
          if (this.followed.get(spaceId) === entry) this.followed.delete(spaceId);
        },
      );
    }
  }

  close(): void {
    this.follow([]);
  }
}
