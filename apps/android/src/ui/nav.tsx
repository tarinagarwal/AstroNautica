/**
 * A small stack navigator (no native navigation dependency): a list of routes, the hardware back button pops.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BackHandler } from "react-native";

export type Route =
  | { name: "home" }
  | { name: "story"; storyId: string; offline?: boolean }
  | { name: "verify"; storyId: string }
  | { name: "tag"; tag: string }
  | { name: "search" }
  | { name: "reach" }
  | { name: "about" }
  | { name: "menu" }
  | { name: "settings" }
  | { name: "keys" }
  | { name: "saved" }
  | { name: "share"; storyId: string }
  | { name: "receive"; zipPath?: string }
  | { name: "update" }
  | { name: "pinSetup"; then?: Route }
  | { name: "contribute" }
  | { name: "invite"; link?: string }
  | { name: "editor"; draftId?: string; submissionId?: string }
  | { name: "moderate" }
  | { name: "review"; submissionId: string };

interface Nav {
  route: Route;
  depth: number;
  push(r: Route): void;
  replace(r: Route): void;
  back(): boolean;
  reset(r?: Route): void;
}

const Ctx = createContext<Nav | null>(null);

export function NavProvider({ children, initial = { name: "home" } }: { children: ReactNode; initial?: Route }) {
  const [stack, setStack] = useState<Route[]>([initial]);
  const back = useCallback(() => {
    let popped = false;
    setStack((s) => {
      if (s.length <= 1) return s;
      popped = true;
      return s.slice(0, -1);
    });
    return popped;
  }, []);
  const value = useMemo<Nav>(
    () => ({
      route: stack[stack.length - 1]!,
      depth: stack.length,
      push: (r) => setStack((s) => [...s, r]),
      replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
      back: () => {
        if (stack.length <= 1) return false;
        back();
        return true;
      },
      reset: (r = { name: "home" }) => setStack([r]),
    }),
    [stack, back],
  );
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => value.back());
    return () => sub.remove();
  }, [value]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav(): Nav {
  const n = useContext(Ctx);
  if (!n) throw new Error("navigation is not available");
  return n;
}
