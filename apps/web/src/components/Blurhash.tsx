import { useEffect, useRef } from "react";
import { decode, isBlurhashValid } from "blurhash";

/** A blurhash placeholder painted on a tiny canvas and stretched by CSS (no network, no inline styles). */
export function Blurhash({ hash, className }: { hash?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !hash || !isBlurhashValid(hash).result) return;
    try {
      const pixels = decode(hash, 32, 32);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const img = ctx.createImageData(32, 32);
      img.data.set(pixels);
      ctx.putImageData(img, 0, 0);
    } catch {
      // an invalid hash just leaves the neutral background
    }
  }, [hash]);
  return <canvas ref={ref} width={32} height={32} className={className ?? "blurhash"} aria-hidden="true" />;
}
