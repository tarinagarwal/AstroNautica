import { inlineText, parseMarkdown } from "../markdown/parse";

describe("safe Markdown", () => {
  it("renders the supported constructs as a tree", () => {
    const t = parseMarkdown("# Head\n\nSome **bold** and *it* [link](https://a.example) `c`\n\n> quote\n\n- one\n- two\n\n1. x\n\n---\n\n```\ncode\n```");
    expect(t.map((b) => b.t)).toEqual(["heading", "paragraph", "quote", "list", "list", "hr", "code"]);
    const p = t[1] as Extract<(typeof t)[number], { t: "paragraph" }>;
    expect(p.children.map((c) => c.t)).toEqual(["text", "strong", "text", "em", "text", "link", "text", "code"]);
    expect(inlineText(p.children)).toBe("Some bold and it link c");
  });

  it("never interprets HTML, images or unsafe links", () => {
    const t = parseMarkdown('<script>alert(1)</script>\n\n![x](https://tracker.example/p.png) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>');
    const json = JSON.stringify(t);
    // Image syntax never loads anything: it degrades to a plain link that opens only after the reader confirms.
    expect(json).not.toMatch(/image|img"/);
    expect(t[1]).toMatchObject({ children: [{ t: "text", text: "!" }, { t: "link", href: "https://tracker.example/p.png" }, expect.anything()] });
    expect(json).toContain("<script>alert(1)</script>");
    expect(json).not.toMatch(/"href":"javascript/);
    expect(parseMarkdown("[m](mailto:a@b.c)")[0]).toMatchObject({ children: [{ t: "link", href: "mailto:a@b.c" }] });
  });

  it("handles Devanagari text", () => {
    expect(inlineText((parseMarkdown("## सुबह\nपानी **बढ़ा**।")[1] as never as { children: never[] }).children)).toBe("पानी बढ़ा।");
  });
});
