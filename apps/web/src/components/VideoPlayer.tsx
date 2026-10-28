import { useEffect, useRef, useState } from "react";
import type { VideoBlock } from "@azaadawaaz/schema";
import { useT } from "../i18n/index.js";
import { fetchBySha } from "../lib/gateways.js";
import { objectUrlFor } from "../lib/media.js";
import { makeVerifiedLoader, virtualUrl } from "../lib/hlsLoader.js";

type Mode = "idle" | "hls" | "mp4-loading" | "mp4" | "failed";

/**
 * HLS through verified IPFS blocks with gateway failover; if HLS can't play, the MP4 fallback fetched and checked by
 * SHA-256. Nothing loads until the reader presses play (except the verified poster). WebTorrent is not used: it needs
 * WebRTC peers and trackers outside the CSP, and the IPFS paths already give several independent sources.
 */
export function VideoPlayer({ block, title }: { block: VideoBlock; title: string }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [poster, setPoster] = useState<string>();
  const [mode, setMode] = useState<Mode>("idle");
  const cleanup = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    fetchBySha(block.poster, { maxBytes: 10 * 1024 * 1024 }).then(
      (b) => !cancelled && setPoster(objectUrlFor(block.poster.sha256, b)),
      () => {},
    );
    return () => {
      cancelled = true;
      cleanup.current();
    };
  }, [block.poster]);

  const playMp4 = async () => {
    setMode("mp4-loading");
    try {
      const bytes = await fetchBySha(block.mp4, { maxBytes: 2 * 1024 * 1024 * 1024, timeoutMs: 600_000 });
      const v = video.current;
      if (!v) return;
      v.src = objectUrlFor(block.mp4.sha256, bytes, "video/mp4");
      setMode("mp4");
      await v.play().catch(() => {});
    } catch {
      setMode("failed");
    }
  };

  const start = async () => {
    const v = video.current;
    if (!v) return;
    try {
      const Hls = (await import("hls.js")).default;
      if (!Hls.isSupported()) return playMp4();
      const hls = new Hls({
        loader: makeVerifiedLoader(),
        enableWorker: false,
        fragLoadingMaxRetry: 2,
        manifestLoadingMaxRetry: 1,
      });
      cleanup.current = () => hls.destroy();
      let fellBack = false;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && !fellBack) {
          fellBack = true;
          hls.destroy();
          void playMp4();
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => void v.play().catch(() => {}));
      hls.attachMedia(v);
      hls.loadSource(virtualUrl(block.hls));
      setMode("hls");
    } catch {
      await playMp4();
    }
  };

  return (
    <figure className="video" data-testid="video-block">
      <div className="video-frame">
        <video
          ref={video}
          controls={mode !== "idle"}
          poster={poster}
          preload="none"
          playsInline
          aria-label={title || t("video.label")}
        />
        {mode === "idle" && (
          <button type="button" className="play" onClick={() => void start()} aria-label={t("video.play")}>
            ▶
          </button>
        )}
      </div>
      {mode === "mp4-loading" && <p className="muted small">{t("video.loadingFallback")}</p>}
      {mode === "failed" && <p className="error small">{t("video.failed")}</p>}
    </figure>
  );
}
