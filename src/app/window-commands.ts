import { useEffect, useLayoutEffect, useRef } from "react";
import app from "../../schema";
import { heinoteCommands, type CommandHost } from "./commands";

/** Offers the window's operations to agents, as schema.ts declares them
 *  (`runs: "window"`) — once, as the window opens, taken back when it closes.
 *  Each call reads the window as it is when the call comes (`host`: null
 *  until HeiNote has opened in it). In this standalone build no host routes
 *  calls to a window: the platform shim's `app.commands` registers nothing,
 *  and agents use the server API. The hook stays so the commands' types
 *  keep checking. */
export function useWindowCommands(host: CommandHost | null): void {
  const latest = useRef(host);
  useLayoutEffect(() => {
    latest.current = host;
  });
  useEffect(() => app.commands(heinoteCommands(() => latest.current)), []);
}
