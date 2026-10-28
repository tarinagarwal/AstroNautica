/**
 * One story's whole life through the real web UI against the real API, publisher, relays, IPFS, ArLocal and both
 * anvil chains (no mocks): owner invite → contributor redeems (new key in the browser) → bilingual story with text,
 * a GPS-tagged photo, a located video and a cover → moderator previews and approves → the publisher publishes →
 * a fresh reader reads, plays and verifies it → comment + reaction → moderator hides the comment → contributor sees
 * "published".
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthHeader, parseSecretKey } from "@azaadawaaz/core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const shots = join(here, "../test-results/real");
const env = () =>
  JSON.parse(readFileSync(join(shots, "env.json"), "utf8")) as {
    apiUrl: string;
    media: string;
  };
const keys = () =>
  JSON.parse(readFileSync(join(repo, ".dev/keys.json"), "utf8")) as {
    owner: { nsec: string; x25519Private: string };
    moderators: { nsec: string; x25519Private: string }[];
  };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const PASS = "correct horse battery staple";
const run = Date.now().toString(36);
const TITLE_EN = `Floods in the valley ${run}`;
const TITLE_HI = `घाटी में बाढ़ ${run}`;
const TEXT_EN = "Water rose **over** the old bridge before dawn.";
const TEXT_HI = "सुबह होने से पहले पानी पुराने पुल के **ऊपर** आ गया।";
const COMMENT = `Stay safe, everyone (${run})`;

/** CSP violations and uncaught errors fail the run: the strict policy must not break anything. */
function watchErrors(page: Page, into: string[]): void {
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text()))
      into.push(`${page.url()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => into.push(`${page.url()}: ${e.message}`));
}

async function newPage(browser: Browser, viewport: { width: number; height: number }, errors: string[]) {
  const ctx = await browser.newContext({ viewport, baseURL: "http://127.0.0.1:4800/" });
  const page = await ctx.newPage();
  watchErrors(page, errors);
  return { ctx, page };
}

const shot = (page: Page, name: string, fullPage = true) =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage });

/** Log in to the moderator area with an nsec and X25519 key (saved encrypted, then unlocked). */
async function moderatorLogin(page: Page, nsec: string, x25519: string) {
  await page.goto("./#/moderate");
  await page.getByLabel("Secret key (nsec…)").fill(nsec);
  await page.getByLabel("X25519 encryption private key (hex)").fill(x25519);
  await page.getByLabel("Choose a passphrase (at least 10 characters)").fill(PASS);
  await page.getByLabel("Repeat the passphrase").fill(PASS);
  await page.getByRole("button", { name: "Save encrypted and continue" }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("link", { name: "Queue" })).toBeVisible();
  await expect(page.locator(".banner.warn")).toHaveCount(0);
}

/** GET an authenticated API route as a moderator (NIP-98), like the moderator client does. */
async function apiGet<T>(path: string, nsec: string): Promise<T> {
  const url = env().apiUrl + path;
  const r = await fetch(url, { headers: { authorization: createAuthHeader(url, "GET", parseSecretKey(nsec)) } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

/** Bytes of an <img>'s blob: URL, read inside the page (it is what the reader actually sees). */
async function imgBytes(page: Page, selector: string): Promise<Buffer> {
  const b64 = await page.locator(selector).first().evaluate(async (el: HTMLImageElement) => {
    const buf = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, "base64");
}

function exif(bytes: Buffer, name: string): string {
  const dir = join(shots, "downloaded");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return execFileSync("exiftool", ["-a", "-G1", "-s", file]).toString();
}

interface Job {
  submissionId: string;
  state: string;
  submissionState: string;
  attempts: number;
  steps: Record<string, { done: boolean; error?: string }>;
}

test("a story's whole life through the real UI and the real dev network", async ({ browser }) => {
  const errors: string[] = [];
  const contexts: BrowserContext[] = [];
  const open = async (viewport = DESKTOP) => {
    const p = await newPage(browser, viewport, errors);
    contexts.push(p.ctx);
    return p.page;
  };
  const k = keys();
  const moderatorKey = k.moderators[0]!;
  let inviteLink = "";
  let submissionId = "";
  let storyId = "";

  // ---------------------------------------------------------------------------------------------------------------
  await test.step("1. owner creates an invite; the contributor redeems it on a new key", async () => {
    const owner = await open();
    await moderatorLogin(owner, k.owner.nsec, k.owner.x25519Private);
    await expect(owner.getByRole("heading", { level: 1 })).toHaveText("Owner and moderator area");
    await owner.getByRole("link", { name: "Owner" }).click();
    await owner.getByLabel("Note (optional, visible to the invitee)").fill(`Valley correspondent ${run}`);
    await owner.getByLabel("Valid for (days)").fill("2");
    await owner.getByRole("button", { name: "Create signed invite" }).click();
    const out = owner.getByTestId("invite-link");
    await expect(out.locator("code")).toContainText("#/invite/");
    inviteLink = (await out.locator("code").textContent())!.trim();
    expect(inviteLink.startsWith("http://127.0.0.1:4800/#/invite/")).toBe(true);
    await shot(owner, "01-owner-invite");
    await owner.context().close();

    const contributor = await open();
    await contributor.goto(inviteLink);
    await expect(contributor.getByTestId("invite")).toContainText("signed by the AzaadAwaaz owner");
    await expect(contributor.getByTestId("invite")).toContainText(`Valley correspondent ${run}`);
    await contributor.getByLabel("Choose a passphrase (at least 10 characters)").fill(PASS);
    await contributor.getByLabel("Repeat the passphrase").fill(PASS);
    await shot(contributor, "02-contributor-invite");
    await contributor.getByRole("button", { name: "Create key and accept invite" }).click();
    await expect(contributor.getByTestId("my-submissions")).toBeVisible();
    await expect(contributor.getByText("You haven't submitted anything yet.")).toBeVisible();
    await shot(contributor, "03-contributor-redeemed");
  });

  // ---------------------------------------------------------------------------------------------------------------
  const contributor = contexts[contexts.length - 1]!.pages()[0]!;
  await test.step("2. contributor writes a bilingual story with photo, video and cover, and submits it", async () => {
    const m = env().media;
    const page = contributor;
    await page.getByRole("link", { name: "New story" }).click();
    await expect(page.getByTestId("editor")).toBeVisible();
    await page.getByLabel("Both").check();
    await page.locator("#title-en").fill(TITLE_EN);
    await page.locator("#title-hi").fill(TITLE_HI);
    await page.locator("#summary-en").fill("What we saw at dawn by the old bridge.");
    await page.locator("#summary-hi").fill("पुराने पुल के पास सुबह हमने क्या देखा।");
    await page.getByLabel("Tags (separated by commas)").fill("floods, बाढ़");
    await page.locator("#location-en").fill("Northern district");
    await page.locator("#location-hi").fill("उत्तरी ज़िला");
    await page.getByLabel("Pen name (optional)").fill("Valley correspondent");

    // Cover (GPS-tagged JPEG): stripped on this device.
    await page.getByLabel("Upload a cover image").setInputFiles(join(m, "cover.jpg"));
    const cover = page.locator("fieldset").filter({ hasText: "Cover image" });
    await expect(cover.getByTestId("metadata-removed")).toHaveText("metadata removed ✓");

    // Text block.
    await page.getByRole("button", { name: "+ Text" }).click();
    await page.locator("#text-0-en").fill(`## Morning\n${TEXT_EN}`);
    await page.locator("#text-0-hi").fill(`## सुबह\n${TEXT_HI}`);

    // Image block with the GPS-tagged photo.
    await page.getByRole("button", { name: "+ Images" }).click();
    const imageBlock = page.getByTestId("block-image");
    await imageBlock.getByLabel("Add images").setInputFiles(join(m, "photo.jpg"));
    await expect(imageBlock.getByTestId("metadata-removed")).toHaveText("metadata removed ✓");
    await page.locator("#cap-1-0-en").fill("The bridge");
    await page.locator("#cap-1-0-hi").fill("पुल");

    // Video block with the located MP4.
    await page.getByRole("button", { name: "+ Video" }).click();
    const videoBlock = page.getByTestId("block-video");
    await videoBlock.getByLabel("Choose a video (MP4 or MOV)").setInputFiles(join(m, "clip.mp4"));
    await expect(videoBlock.getByTestId("metadata-removed")).toHaveText("metadata removed ✓", { timeout: 60_000 });
    await page.locator("#vt-2-en").fill("Six seconds at the bridge");
    await page.locator("#vt-2-hi").fill("पुल पर छह सेकंड");

    await expect(page.getByTestId("metadata-removed")).toHaveCount(3);
    await expect(page.locator(".error[role=alert]")).toHaveCount(0);
    await shot(page, "04-editor-filled");

    const created = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/submissions",
    );
    await page.getByRole("button", { name: "Encrypt and submit for review" }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    submissionId = ((await res.json()) as { id: string }).id;
    await expect(page.getByTestId("my-submissions")).toBeVisible({ timeout: 120_000 });
    const mine = page.locator(".submission").filter({ hasText: TITLE_EN });
    await expect(mine).toContainText("waiting for review");
    await shot(page, "05-contributor-submitted");
  });

  // ---------------------------------------------------------------------------------------------------------------
  await test.step("3. moderator logs in, opens the queue, previews the decrypted story and approves", async () => {
    const page = await open();
    await moderatorLogin(page, moderatorKey.nsec, moderatorKey.x25519Private);
    const queue = page.getByTestId("queue");
    const item = queue.getByRole("link", { name: `Submission ${submissionId.slice(0, 8)}` });
    await expect(item).toBeVisible();
    await shot(page, "06-moderator-queue");
    await item.click();
    const review = page.getByTestId("review");
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(review.getByRole("heading", { level: 1 })).toHaveText(TITLE_EN);
    await expect(review.locator(".md")).toContainText("Water rose over the old bridge before dawn.");
    // Decrypted, hash-checked image from the encrypted staging chunks.
    const img = review.locator(".story-body img").first();
    await img.scrollIntoViewIfNeeded();
    await expect(img).toHaveAttribute("src", /^blob:/, { timeout: 60_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(review).toContainText("in review");
    await shot(page, "07-moderator-preview-en");
    await review.getByTestId("story-lang").getByRole("button", { name: "हिन्दी" }).click();
    await expect(review.getByRole("heading", { level: 1 })).toHaveText(TITLE_HI);
    await expect(review.locator(".md")).toContainText("सुबह होने से पहले पानी");
    await shot(page, "08-moderator-preview-hi");

    await review.getByRole("button", { name: "Approve", exact: true }).click();
    await review.getByRole("button", { name: "Sign and approve" }).click();
    await expect(review.getByRole("status")).toHaveText("Approved. Publishing has started.");
    await shot(page, "09-moderator-approved");
  });

  // ---------------------------------------------------------------------------------------------------------------
  await test.step("4. the publisher publishes (every step, both chains)", async () => {
    let last: Job | undefined;
    await expect
      .poll(
        async () => {
          const jobs = await apiGet<Job[]>("/jobs", moderatorKey.nsec);
          last = jobs.find((j) => j.submissionId === submissionId);
          if (last?.state === "failed" && last.attempts > 2)
            throw new Error(`publish job failing: ${JSON.stringify(last.steps)}`);
          return last ? `${last.submissionState}/${last.state}` : "none";
        },
        { timeout: 10 * 60_000, intervals: [2000] },
      )
      .toBe("published/done");
    storyId = ((await apiGet<{ storyId: string }[]>("/jobs", moderatorKey.nsec)).find(
      (j) => (j as unknown as Job).submissionId === submissionId,
    ) as { storyId: string }).storyId;
    expect(Object.keys(last!.steps)).toEqual(expect.arrayContaining(["chain:base-local", "chain:bsc-local"]));

    // The same status in the moderator's Publishing page.
    const page = contexts[contexts.length - 1]!.pages()[0]!;
    await page.getByRole("link", { name: "Publishing" }).click();
    const job = page.locator(".job").filter({ hasText: submissionId.slice(0, 8) });
    await expect(job).toContainText("done");
    await expect(job.locator(".steps li.ok")).toHaveCount(Object.keys(last!.steps).length);
    await shot(page, "10-moderator-jobs");
  });

  // ---------------------------------------------------------------------------------------------------------------
  const reader = await open(PHONE);
  await test.step("5. a fresh reader finds, reads, plays and verifies the story", async () => {
    const page = reader;
    const rawRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("format=raw")) rawRequests.push(r.url());
    });
    await page.goto("./#/");
    const card = page.getByTestId("story-card").filter({ hasText: TITLE_EN });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await shot(page, "11-reader-home-phone");
    await card.getByRole("link").first().click();
    await expect(page.getByTestId("story")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE_EN);
    await expect(page.locator(".story-body .md")).toContainText("Water rose over the old bridge before dawn.");
    expect(page.url()).toContain(storyId);

    // The image, from a verified blob, decodes; it carries no GPS (or any EXIF).
    const img = page.locator(".story-body [data-testid=image-block] .vimg img").first();
    await img.scrollIntoViewIfNeeded();
    await expect(img).toHaveAttribute("src", /^blob:/, { timeout: 60_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    const shown = exif(await imgBytes(page, ".story-body [data-testid=image-block] .vimg img"), "story-image");
    expect(shown).not.toMatch(/GPS|Samsung|SM-G991B|Real Name/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "12-reader-story-en-phone");

    // Hindi.
    await page.getByTestId("story-lang").getByRole("button", { name: "हिन्दी" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE_HI);
    await expect(page.locator(".story-body .md")).toContainText("सुबह होने से पहले पानी");
    await expect(page.getByText("पुल", { exact: true })).toBeVisible();
    await shot(page, "13-reader-story-hi-phone");
    await page.getByTestId("story-lang").getByRole("button", { name: "English" }).click();

    // Video: HLS through the verified loader.
    const videoBlock = page.getByTestId("video-block");
    await videoBlock.scrollIntoViewIfNeeded();
    await expect(videoBlock.locator("video")).toHaveAttribute("poster", /^blob:/, { timeout: 60_000 });
    const before = rawRequests.length;
    await videoBlock.getByRole("button", { name: "Play video" }).click();
    await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-testid=video-block] video")!;
      v.muted = true;
      void v.play().catch(() => {});
    });
    const video = videoBlock.locator("video");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 60_000 })
      .toBeGreaterThan(0.5);
    expect(rawRequests.length).toBeGreaterThan(before);
    expect(await video.evaluate((v: HTMLVideoElement) => v.src.startsWith("blob:") && v.videoWidth > 0)).toBe(true);
    await shot(page, "14-reader-video-phone", false);

    // Verify: the green badge, both chain receipts and Arweave.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByTestId("verify-button").click();
    const panel = page.getByTestId("verify-panel");
    await expect(page.getByTestId("verify-verdict")).toHaveText(/Original and unedited/, { timeout: 90_000 });
    await expect(page.getByTestId("verify-verdict")).toHaveClass(/ok/);
    const receipts = panel.getByTestId("chain-receipt");
    await expect(receipts).toHaveCount(2);
    for (const r of await receipts.all()) await expect(r.locator(".mark")).toHaveClass(/ok/);
    await expect(panel.locator("dt").filter({ hasText: "Arweave" }).locator(".mark")).toHaveClass(/ok/);
    await expect(panel.locator(".mark.fail")).toHaveCount(0);
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: join(shots, "15-reader-verify-phone.png") });
  });

  // ---------------------------------------------------------------------------------------------------------------
  await test.step("6. reader comments and reacts; the moderator hides the comment", async () => {
    const page = reader;
    await page.getByLabel("Write a comment").first().fill(COMMENT);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByTestId("comment").filter({ hasText: COMMENT })).toBeVisible({ timeout: 120_000 });
    await page.getByTestId("reaction-👍").click();
    await expect(page.getByTestId("reaction-👍")).toContainText("1", { timeout: 120_000 });
    await page.reload();
    await expect(page.getByTestId("comment").filter({ hasText: COMMENT })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("reaction-👍")).toContainText("1");
    await page.getByTestId("comments").scrollIntoViewIfNeeded();
    await shot(page, "16-reader-comment-phone");

    const mod = contexts.find((c) => c.pages()[0]?.url().includes("/moderate"))!.pages()[0]!;
    // In-app navigation keeps the unlocked moderator session (it lives in memory only).
    await mod.evaluate((id) => (location.hash = `#/story/${id}`), storyId);
    const item = mod.getByTestId("comment").filter({ hasText: COMMENT });
    await expect(item).toBeVisible({ timeout: 60_000 });
    await item.getByRole("button", { name: "Hide comment" }).click();
    await expect(mod.getByTestId("comment").filter({ hasText: COMMENT })).toHaveCount(0, { timeout: 60_000 });
    await shot(mod, "17-moderator-hid-comment");

    const fresh = await open(PHONE);
    await fresh.goto(`./#/story/${storyId}`);
    await expect(fresh.getByRole("heading", { level: 1 })).toHaveText(TITLE_EN);
    await expect(fresh.getByTestId("comments")).toBeVisible();
    await expect(fresh.getByText("No comments yet.")).toBeVisible({ timeout: 60_000 });
    await expect(fresh.getByText(COMMENT)).toHaveCount(0);
    await expect(fresh.getByTestId("reaction-👍")).toContainText("1");
    await fresh.getByTestId("comments").scrollIntoViewIfNeeded();
    await shot(fresh, "18-new-reader-comment-hidden-phone");
  });

  // ---------------------------------------------------------------------------------------------------------------
  await test.step("7. the contributor's submissions show it published", async () => {
    const page = contributor;
    await page.evaluate(() => (location.hash = "#/contribute"));
    const mine = page.locator(".submission").filter({ hasText: TITLE_EN });
    await expect(mine.locator(".state")).toHaveText("published");
    await expect(mine.getByRole("link", { name: "View" })).toBeVisible();
    await shot(page, "19-contributor-published");
  });

  for (const c of contexts) await c.close().catch(() => {});
  expect(errors).toEqual([]);
});
