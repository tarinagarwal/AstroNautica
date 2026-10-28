import { useEffect, useRef, useState } from "react";
import { Blurhash } from "./Blurhash.js";
import { useT } from "../i18n/index.js";
import type { ImageVariants } from "@azaadawaaz/schema";
import { fetchByCid, fetchBySha } from "../lib/gateways.js";
import { objectUrlFor } from "../lib/media.js";

export type ImageLoader = (targetWidth: number) => Promise<string>;

/**
 * An image that is fetched only when near the viewport, verified by hash, and shown from a blob URL. The blurhash
 * placeholder holds the space meanwhile. Variant choice happens here rather than through `srcset`, because a browser
 * fetching `srcset` candidates directly would display bytes nobody verified.
 */
export function VerifiedImage(props: {
  load: ImageLoader;
  width?: number;
  height?: number;
  blurhash?: string;
  alt: string;
  className?: string;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const { load } = props;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    const start = () => {
      const target = Math.ceil((el.clientWidth || 480) * (globalThis.devicePixelRatio || 1));
      load(target).then(
        (u) => !cancelled && setUrl(u),
        () => !cancelled && setFailed(true),
      );
    };
    if (typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [load]);

  const ratio = props.width && props.height ? `${props.width} / ${props.height}` : undefined;
  return (
    <div ref={box} className={"vimg " + (props.className ?? "")} style={ratio ? { aspectRatio: ratio } : undefined}>
      {!url && <Blurhash hash={props.blurhash} />}
      {url && <img src={url} alt={props.alt} decoding="async" />}
      {failed && !url && <span className="vimg-error">{t("media.unavailable")}</span>}
    </div>
  );
}

const WIDTHS = ["480", "960", "1600"] as const;

/** Pick the smallest variant at least as wide as needed (never wider than the original). */
export function pickVariant(
  variants: ImageVariants | undefined,
  target: number,
  originalWidth?: number,
): string | undefined {
  if (!variants) return undefined;
  for (const w of WIDTHS) {
    if (variants[w] && Number(w) >= target) return variants[w];
  }
  // Nothing wide enough: the original is best if we know it's wider, otherwise the largest variant.
  if (originalWidth && originalWidth > 1600) return undefined;
  return [...WIDTHS]
    .reverse()
    .map((w) => variants[w])
    .find(Boolean);
}

/** Loader for a published image: a CID-verified variant, falling back to the SHA-256-verified original. */
export function publishedImageLoader(item: {
  sha256?: string;
  cid: string;
  variants?: ImageVariants;
  width?: number;
}): ImageLoader {
  return async (target) => {
    const variant = pickVariant(item.variants, target, item.width);
    if (variant) {
      try {
        return objectUrlFor(variant, await fetchByCid(variant, 20 * 1024 * 1024));
      } catch {
        // fall back to the original
      }
    }
    const bytes = item.sha256
      ? await fetchBySha({ cid: item.cid, sha256: item.sha256 }, { maxBytes: 25 * 1024 * 1024 })
      : await fetchByCid(item.cid, 25 * 1024 * 1024);
    return objectUrlFor(item.sha256 ?? item.cid, bytes);
  };
}
