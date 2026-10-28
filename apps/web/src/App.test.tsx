import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createListEvent } from "@azaadawaaz/core";
import { App } from "./App.js";
import { AppData } from "./data/appData.js";
import { normalize } from "./config.js";
import { setFetch } from "./lib/gateways.js";
import { idbReset } from "./lib/idb.js";
import { FakePool, TEST_URLS, worldFetch } from "./test/fakes.js";
import { createWorld, everyBlockStory, publishStory, textStory, worldConfig, type World } from "./test/world.js";

let world: World;
let pool: FakePool;
let app: AppData;

beforeEach(async () => {
  await idbReset();
  await new Promise<void>((r) => {
    const req = indexedDB.deleteDatabase("azaadawaaz");
    req.onsuccess = req.onerror = req.onblocked = () => r();
  });
  localStorage.setItem("azaad:lang", "en");
  world = await createWorld(TEST_URLS);
  const embedded = publishStory(world, textStory(world, "Embedded update"));
  publishStory(world, await everyBlockStory(world, embedded.manifest.id));
  pool = new FakePool([...world.listEvents, ...world.stories.flatMap((s) => [s.event, s.receipt])]);
  const f = worldFetch(world);
  setFetch(f);
  vi.stubGlobal("fetch", f);
  app = new AppData(normalize({ ...worldConfig(world), listEvents: world.listEvents }), pool);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const main = () => world.stories[1]!.manifest;

async function openStory() {
  window.location.hash = `#/story/${main().id}`;
  render(<App app={app} />);
  return screen.findByRole("heading", { level: 1, name: "Floods in the valley" }, { timeout: 5000 });
}

describe("reader UI", () => {
  it("home lists the stories from relays", async () => {
    render(<App app={app} />);
    const cards = await screen.findAllByTestId("story-card");
    expect(cards.map((c) => within(c).getByRole("heading").textContent)).toEqual([
      "Floods in the valley",
      "Embedded update",
    ]);
  });

  it("home shows a clear state when no official lists are found", async () => {
    app = new AppData(normalize({}), new FakePool());
    render(<App app={app} />);
    expect(await screen.findByTestId("no-lists")).toHaveProperty(
      "textContent",
      expect.stringContaining("No official lists found"),
    );
  });

  it("the story page renders every block type, safely", async () => {
    await openStory();
    // Text: Markdown rendered, raw HTML shown as text, links hardened.
    expect(screen.getByRole("heading", { level: 2, name: "Morning" })).toBeTruthy();
    expect(document.querySelector(".md script")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Relief line" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // Gallery with captions, single image, video, embedded story.
    expect(screen.getAllByTestId("image-block")).toHaveLength(2);
    expect(screen.getByText("The bridge")).toBeTruthy();
    expect(screen.getByText("The market")).toBeTruthy();
    expect(screen.getByTestId("video-block")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Interview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play video" })).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId("embed-block")).getByText("Embedded update")).toBeTruthy());
    // Images are shown from verified blob URLs.
    await waitFor(() => expect(document.querySelectorAll(".vimg img").length).toBeGreaterThanOrEqual(3));
    for (const img of document.querySelectorAll(".vimg img")) expect(img.getAttribute("src")).toMatch(/^blob:/);
  });

  it("switches the story language for bilingual stories", async () => {
    await openStory();
    fireEvent.click(within(screen.getByTestId("story-lang")).getByRole("button", { name: "हिन्दी" }));
    expect(await screen.findByRole("heading", { level: 1, name: "घाटी में बाढ़" })).toBeTruthy();
    expect(screen.getByText("पुल")).toBeTruthy();
  });

  it("the header language switch changes the UI language", async () => {
    render(<App app={app} />);
    await screen.findAllByTestId("story-card");
    fireEvent.click(screen.getAllByRole("button", { name: "हिन्दी" })[0]!);
    expect(await screen.findByRole("heading", { name: "ताज़ा कहानियाँ" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("hi");
  });

  it("Verify shows green 'original and unedited' for a genuine story", async () => {
    await openStory();
    fireEvent.click(screen.getByTestId("verify-button"));
    await waitFor(() => expect(screen.getByTestId("verify-verdict").textContent).toContain("Original and unedited"), {
      timeout: 5000,
    });
    expect(screen.getAllByTestId("chain-receipt")[0]!.textContent).toContain("Base (local)");
  });

  it("Verify shows red and 'source flagged' for a tampered manifest", async () => {
    const b = world.stories[1]!;
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(b.bytes).replace("Bridge closed", "Bridge open"),
    );
    setFetch(worldFetch(world, { cids: new Map([[b.cid, tampered]]) }));
    world.arweave.set(b.arweaveTx, tampered);
    window.location.hash = `#/story/${main().id}`;
    render(<App app={app} />);
    expect(await screen.findByTestId("story-error", undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("verify-verdict").textContent).toContain("Could not verify"), {
      timeout: 5000,
    });
    expect(screen.getByTestId("source-flagged").textContent).toContain(TEST_URLS.gateway);
    // Nothing from the tampered copy is rendered.
    expect(screen.queryByText("Bridge open")).toBeNull();
  });

  it("an unlisted story is hidden from home and shows an honest notice", async () => {
    pool.push(createListEvent("unlisted", [[main().id, Math.floor(Date.now() / 1000)]], world.moderator.secretKey));
    window.location.hash = `#/story/${main().id}`;
    render(<App app={app} />);
    expect((await screen.findByTestId("story-unlisted", undefined, { timeout: 5000 })).textContent).toContain(
      "can't be erased",
    );
  });

  it("posts a comment with proof-of-work, counts reactions, and hides a comment once a moderator's hide list arrives", async () => {
    await openStory();
    const box = screen.getByLabelText("Write a comment", { selector: "textarea" });
    fireEvent.change(box, { target: { value: "Stay safe, everyone." } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    const comment = await screen.findByTestId("comment", undefined, { timeout: 10000 });
    expect(comment.textContent).toContain("Stay safe, everyone.");
    expect(await screen.findByTestId("backup-prompt")).toBeTruthy();
    const posted = pool.published.find((e) => e.kind === 1111)!;
    expect(posted.tags.find((t) => t[0] === "nonce")?.[2]).toBe("8");

    fireEvent.click(screen.getByTestId("reaction-👍"));
    await waitFor(() => expect(screen.getByTestId("reaction-👍").textContent).toContain("1"), { timeout: 10000 });

    await act(async () => {
      pool.push(createListEvent("hidden", [[posted.id, Math.floor(Date.now() / 1000)]], world.moderator.secretKey));
    });
    expect(app.lists!.hidden.has(posted.id)).toBe(true);
    await waitFor(() => expect(screen.queryAllByTestId("comment")).toHaveLength(0));
    expect(comment.isConnected).toBe(false);
  });

  it("search finds stories by title and tag on the device", async () => {
    window.location.hash = "#/search?q=valley";
    render(<App app={app} />);
    await waitFor(() => expect(screen.getAllByTestId("story-card")).toHaveLength(1));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Floods in the valley");
  });

  it("'How to reach us' lists doors from the signed lists", async () => {
    window.location.hash = "#/reach";
    render(<App app={app} />);
    const page = await screen.findByTestId("reach");
    await waitFor(() => expect(within(page).getByText("azaadawaaz.example")).toBeTruthy());
    expect(within(page).getByText("t.me/azaadawaaz_test")).toBeTruthy();
    expect(within(page).getByText(/\.onion$/)).toBeTruthy();
  });
});
