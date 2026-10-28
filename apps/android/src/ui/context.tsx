import React, { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import type { Services } from "../services";

const Ctx = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}

export function useServices(): Services {
  const s = useContext(Ctx);
  if (!s) throw new Error("services are not available");
  return s;
}

/** Re-render when an observable service (AppData, NetController, KeyRing) changes. */
export function useObservable(source: { onChange(fn: () => void): () => void }): void {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => source.onChange(force), [source]);
}
