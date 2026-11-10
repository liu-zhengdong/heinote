import { useEffect, useLayoutEffect, useRef } from "react";
import app from "../../schema";
import { notesCommands, type CommandHost } from "./commands";

/** Offers the window's operations to agents, as schema.ts declares them
 *  (`runs: "window"`) — once, as the window opens, taken back when it closes.
 *  Each call reads the window as it is when the call comes (`host`: null
 *  until Notes has opened in it). Where nothing can reach the page's tools
 *  (Chrome, anywhere but the Terminus desktop), the SDK registers nothing. */
export function useWindowCommands(host: CommandHost | null): void {
  const latest = useRef(host);
  useLayoutEffect(() => {
    latest.current = host;
  });
  useEffect(() => app.commands(notesCommands(() => latest.current)), []);
}
