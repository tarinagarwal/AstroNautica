import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import type { AppData } from "./appData.js";

const Ctx = createContext<AppData | null>(null);

export function DataProvider({ app, children, autoRefresh = true }: { app: AppData; children: ReactNode; autoRefresh?: boolean }) {
  useEffect(() => {
    let stop = false;
    void app.init().then(() => {
      if (!stop && autoRefresh) void app.refresh();
    });
    const timer = autoRefresh
      ? setInterval(() => {
          if (typeof navigator === "undefined" || navigator.onLine !== false) void app.refresh();
        }, 120_000)
      : undefined;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
      app.unwatch();
    };
  }, [app, autoRefresh]);
  return <Ctx.Provider value={app}>{children}</Ctx.Provider>;
}

/** The data layer; re-renders the caller whenever lists or stories change. */
export function useApp(): AppData {
  const app = useContext(Ctx);
  if (!app) throw new Error("useApp outside DataProvider");
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => app.onChange(bump), [app]);
  return app;
}
