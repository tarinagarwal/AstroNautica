/**
 * Safe Markdown (spec §4, §12): raw HTML is never rendered (`html: false` escapes it), images are disabled (no
 * third-party requests), and only http(s) and mailto links are allowed; links open with noopener noreferrer.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });
md.disable(["image", "html_block", "html_inline"]);

const SAFE_LINK = /^(https?:|mailto:)/i;
md.validateLink = (url: string) => SAFE_LINK.test(url.trim()) || /^#\//.test(url.trim());

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!;
  const href = t.attrGet("href") ?? "";
  if (!href.startsWith("#/")) {
    t.attrSet("target", "_blank");
    t.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(src: string): string {
  return md.render(src);
}
