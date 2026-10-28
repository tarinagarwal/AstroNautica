import { useState } from "react";
import { useT } from "../i18n/index.js";

export function ShareButton({ title }: { title: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = location.href;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // cancelled or unavailable: fall back to copying
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt(t("story.copyPrompt"), url);
    }
  };
  return (
    <button type="button" className="secondary" onClick={() => void share()}>
      {copied ? t("story.copied") : t("story.share")}
    </button>
  );
}
