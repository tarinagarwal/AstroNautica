import { useCallback, useEffect, useState } from "react";
import { KIND_COMMENT, KIND_REACTION } from "@core/kinds.js";
import type { StoryRef } from "@core/stories.js";
import type { Event, EventTemplate } from "nostr-tools/pure";
import type { AppData } from "./appData.js";
import { ensureReaderKey } from "../lib/readerKey.js";
import { mineInWorker } from "../lib/pow.js";

/** Comments and reactions for a story: loaded from all relays, kept live, and posted with proof-of-work. */
export function useSocial(app: AppData, story: StoryRef) {
  const [events, setEvents] = useState<Event[]>([]);
  const [loaded, setLoaded] = useState(false);

  const add = useCallback((es: Event[]) => {
    setEvents((prev) => {
      const ids = new Set(prev.map((e) => e.id));
      const fresh = es.filter((e) => !ids.has(e.id));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }, []);

  useEffect(() => {
    const relays = app.relayUrls();
    let stop = false;
    setEvents([]);
    setLoaded(false);
    Promise.all([
      app.pool.query(relays, { kinds: [KIND_COMMENT], "#A": [story.address], limit: 500 }).catch(() => []),
      app.pool.query(relays, { kinds: [KIND_REACTION], "#a": [story.address], limit: 2000 }).catch(() => []),
    ]).then(([c, r]) => {
      if (stop) return;
      add([...c, ...r]);
      setLoaded(true);
    });
    const since = Math.floor(Date.now() / 1000) - 30;
    const unsubs = [
      app.pool.subscribe(relays, { kinds: [KIND_COMMENT], "#A": [story.address], since }, (e) => add([e])),
      app.pool.subscribe(relays, { kinds: [KIND_REACTION], "#a": [story.address], since }, (e) => add([e])),
    ];
    return () => {
      stop = true;
      unsubs.forEach((u) => u());
    };
  }, [app, story.address, add]);

  /** Sign with the reader key (created on first use) after mining PoW, publish everywhere, show immediately. */
  const post = useCallback(
    async (template: EventTemplate): Promise<{ event: Event; createdKey: boolean; accepted: number }> => {
      const { key, created } = await ensureReaderKey();
      const event = await mineInWorker(template, key.secretKey, app.config.powDifficulty);
      const results = await app.publish(event);
      const accepted = results.filter((r) => r.ok).length;
      if (accepted > 0) add([event]);
      return { event, createdKey: created, accepted };
    },
    [app, add],
  );

  return { events, loaded, post };
}
