/**
 * Safe Markdown (spec §4, §12): markdown-it in CommonMark mode with raw HTML and images disabled turns story text
 * into a small tree that the app renders with native Text components; nothing is ever interpreted as HTML. Links are
 * kept only for http(s) and mailto and open through a confirmation, never automatically.
 */
import MarkdownIt from "markdown-it";

type Token = ReturnType<MarkdownIt["parse"]>[number];

const md = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });
md.disable(["image", "html_block", "html_inline"]);

const SAFE_LINK = /^(https?:|mailto:)/i;
md.validateLink = (url: string) => SAFE_LINK.test(url.trim());

export type Inline =
  | { t: "text"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "code"; text: string }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "br" };

export type MdBlock =
  | { t: "heading"; level: number; children: Inline[] }
  | { t: "paragraph"; children: Inline[] }
  | { t: "quote"; children: MdBlock[] }
  | { t: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: "code"; text: string }
  | { t: "hr" };

function inlines(tokens: Token[] | null): Inline[] {
  const root: Inline[] = [];
  const stack: Inline[][] = [root];
  const top = () => stack[stack.length - 1]!;
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case "text":
        if (tok.content) top().push({ t: "text", text: tok.content });
        break;
      case "code_inline":
        top().push({ t: "code", text: tok.content });
        break;
      case "softbreak":
        top().push({ t: "text", text: " " });
        break;
      case "hardbreak":
        top().push({ t: "br" });
        break;
      case "strong_open":
      case "em_open":
      case "link_open": {
        const node: Inline =
          tok.type === "strong_open"
            ? { t: "strong", children: [] }
            : tok.type === "em_open"
              ? { t: "em", children: [] }
              : { t: "link", href: tok.attrGet("href") ?? "", children: [] };
        top().push(node);
        stack.push((node as { children: Inline[] }).children);
        break;
      }
      case "strong_close":
      case "em_close":
      case "link_close":
        if (stack.length > 1) stack.pop();
        break;
      default:
        // Anything else (html is disabled) is shown as its literal text, never interpreted.
        if (tok.content) top().push({ t: "text", text: tok.content });
    }
  }
  return root;
}

export function parseMarkdown(src: string): MdBlock[] {
  const tokens = md.parse(src, {});
  let i = 0;
  const parse = (until?: string): MdBlock[] => {
    const out: MdBlock[] = [];
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (until && tok.type === until) {
        i++;
        return out;
      }
      i++;
      switch (tok.type) {
        case "heading_open": {
          const inline = tokens[i++]!;
          i++; // heading_close
          out.push({ t: "heading", level: Number(tok.tag.slice(1)) || 1, children: inlines(inline.children) });
          break;
        }
        case "paragraph_open": {
          const inline = tokens[i++]!;
          i++; // paragraph_close
          out.push({ t: "paragraph", children: inlines(inline.children) });
          break;
        }
        case "blockquote_open":
          out.push({ t: "quote", children: parse("blockquote_close") });
          break;
        case "bullet_list_open":
        case "ordered_list_open": {
          const ordered = tok.type === "ordered_list_open";
          const close = ordered ? "ordered_list_close" : "bullet_list_close";
          const items: MdBlock[][] = [];
          while (i < tokens.length && tokens[i]!.type !== close) {
            if (tokens[i]!.type === "list_item_open") {
              i++;
              items.push(parse("list_item_close"));
            } else i++;
          }
          i++;
          out.push({ t: "list", ordered, start: Number(tok.attrGet("start") ?? 1) || 1, items });
          break;
        }
        case "fence":
        case "code_block":
          out.push({ t: "code", text: tok.content.replace(/\n$/, "") });
          break;
        case "hr":
          out.push({ t: "hr" });
          break;
        case "inline":
          // Tight list items carry inline tokens without a paragraph.
          out.push({ t: "paragraph", children: inlines(tok.children) });
          break;
        default:
          break;
      }
    }
    return out;
  };
  return parse();
}

/** Plain text of inline nodes (for accessibility labels and previews). */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === "text" || n.t === "code" ? n.text : n.t === "br" ? "\n" : inlineText(n.children)))
    .join("");
}
