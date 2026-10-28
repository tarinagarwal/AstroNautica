import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "../test-results");
const world = () =>
  JSON.parse(readFileSync(join(here, "../test-results/e2e/world.json"), "utf8")) as {
    storyId: string;
    embeddedId: string;
    unlistedId: string;
    hlsCid: string;
    moderatorNsec: string;
    moderatorX25519: string;
  };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** Fail on CSP violations and uncaught errors: the strict policy must not break anything. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test.describe.serial("reader, verify, comments and moderation against a real relay", () => {
  const comment = `Stay safe, everyone (${Date.now()})`;

  test("home lists the published story on a phone, but not the unlisted one", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize(PHONE);
    await page.goto("./#/");
    const cards = page.getByTestId("story-card");
    await expect(cards.first()).toContainText("Floods in the valley");
    await expect(cards).toHaveCount(2);
    await expect(page.getByText("Unlisted story")).toHaveCount(0);
    await expect(page.locator(".card-cover img")).toBeVisible();
    await page.screenshot({ path: join(shots, "home-phone.png"), fullPage: true });
    expect(errors).toEqual([]);
  });

  test("story page renders every block type from verified IPFS blocks", async ({ page }) => {
    const errors = watchErrors(page);
    const raw: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("format=raw")) raw.push(r.url());
    });
    await page.setViewportSize(PHONE);
    await page.goto(`./#/story/${world().storyId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Floods in the valley");
    await expect(page.getByRole("heading", { level: 2, name: "Morning" })).toBeVisible();
    await expect(page.locator(".md")).toContainText("<script>alert(1)</script>");
    await expect(page.locator(".md script")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Relief line" })).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByTestId("image-block")).toHaveCount(2);
    await expect(page.getByText("The bridge")).toBeVisible();
    await expect(page.getByTestId("embed-block")).toContainText("Embedded update");
    // Images load lazily near the viewport, from a blob URL created after hash verification, and actually decode.
    const boxes = page.locator(".story-body .vimg");
    await expect(boxes).toHaveCount(3);
    for (const box of await boxes.all()) {
      await box.scrollIntoViewIfNeeded();
      const img = box.locator("img");
      await expect(img).toHaveAttribute("src", /^blob:/);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(shots, "story-phone.png"), fullPage: true });

    // Video: HLS through the verified loader (playlists and segments as CID-checked blocks).
    const videoBlock = page.getByTestId("video-block");
    await videoBlock.scrollIntoViewIfNeeded();
    await expect(videoBlock.locator("video")).toHaveAttribute("poster", /^blob:/);
    await page.getByRole("button", { name: "Play video" }).click();
    await expect.poll(() => raw.filter((u) => u.includes(world().hlsCid)).length).toBeGreaterThan(0);
    const video = videoBlock.locator("video");
    await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-testid=video-block] video")!;
      v.muted = true;
      void v.play().catch(() => {});
    });
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
      .toBeGreaterThan(0.2);
    await page.screenshot({ path: join(shots, "video-phone.png") });
    expect(errors).toEqual([]);
  });

  test("Verify panel shows every check passing and the green badge", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(`./#/story/${world().storyId}`);
    await page.getByTestId("verify-button").click();
    await expect(page.getByTestId("verify-verdict")).toHaveText(/Original and unedited/, { timeout: 30_000 });
    await expect(page.getByTestId("chain-receipt")).toContainText("Base (local)");
    await page.getByTestId("verify-panel").scrollIntoViewIfNeeded();
    await page.getByTestId("verify-panel").screenshot({ path: join(shots, "verify-phone.png") });
  });

  test("language switches: per story and for the whole interface", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(`./#/story/${world().storyId}`);
    await page.getByTestId("story-lang").getByRole("button", { name: "हिन्दी" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("घाटी में बाढ़");
    await expect(page.getByRole("heading", { level: 2, name: "सुबह" })).toBeVisible();
    await page.locator(".header").getByRole("button", { name: "हिन्दी" }).click();
    await expect(page.locator(".nav")).toContainText("मुखपृष्ठ");
    await expect(page.getByTestId("verify-button")).toHaveText("सत्यापित करें");
    await page.screenshot({ path: join(shots, "story-hindi-phone.png") });
    await page.locator(".header").getByRole("button", { name: "English" }).click();
  });

  test("a comment with proof-of-work and a reaction are published to the relay", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(`./#/story/${world().storyId}`);
    await page.getByLabel("Write a comment").first().fill(comment);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByTestId("comment").filter({ hasText: comment })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("backup-prompt")).toBeVisible();
    await page.getByTestId("reaction-👍").click();
    await expect(page.getByTestId("reaction-👍")).toContainText("1", { timeout: 60_000 });
    // Reload: both come back from the relay, not from local state.
    await page.reload();
    await expect(page.getByTestId("comment").filter({ hasText: comment })).toBeVisible();
    await expect(page.getByTestId("reaction-👍")).toContainText("1");
    await expect(page.getByTestId("reaction-👍")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("comments").screenshot({ path: join(shots, "comments-phone.png") });
  });

  test("a moderator hides the comment; it disappears for every reader", async ({ page, browser }) => {
    const errors = watchErrors(page);
    const w = world();
    await page.setViewportSize(DESKTOP);
    await page.goto("./#/moderate");
    await page.getByLabel("Secret key (nsec…)").fill(w.moderatorNsec);
    await page.getByLabel("X25519 encryption private key (hex)").fill(w.moderatorX25519);
    await page.getByLabel("Choose a passphrase (at least 10 characters)").fill("correct horse battery");
    await page.getByLabel("Repeat the passphrase").fill("correct horse battery");
    await page.getByRole("button", { name: "Save encrypted and continue" }).click();
    await page.getByLabel("Passphrase", { exact: true }).fill("correct horse battery");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("link", { name: "Queue" })).toBeVisible();
    await expect(page.locator(".banner.warn")).toHaveCount(0);
    await page.screenshot({ path: join(shots, "moderator-desktop.png") });

    await page.goto(`./#/story/${w.storyId}`);
    const item = page.getByTestId("comment").filter({ hasText: comment });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Hide comment" }).click();
    await expect(page.getByTestId("comment").filter({ hasText: comment })).toHaveCount(0);

    // A different reader (fresh browser profile) gets the signed hidden list from the relay.
    const other = await browser.newContext({ viewport: PHONE });
    const p2 = await other.newPage();
    await p2.goto(`./#/story/${w.storyId}`);
    await expect(p2.getByRole("heading", { level: 1 })).toHaveText("Floods in the valley");
    await expect(p2.getByTestId("comments")).toBeVisible();
    await expect(p2.getByText("No comments yet.")).toBeVisible();
    await expect(p2.getByText(comment)).toHaveCount(0);
    await other.close();
    expect(errors).toEqual([]);
  });

  test("desktop layout", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("./#/");
    await expect(page.getByTestId("story-card").first()).toBeVisible();
    await page.screenshot({ path: join(shots, "home-desktop.png"), fullPage: true });
    await page.goto(`./#/story/${world().storyId}`);
    await expect(page.locator(".story-body .vimg img").first()).toBeVisible();
    await page.screenshot({ path: join(shots, "story-desktop.png"), fullPage: true });
    await page.goto("./#/reach");
    await expect(page.getByTestId("reach")).toContainText("azaadawaaz.example");
    await page.screenshot({ path: join(shots, "reach-desktop.png"), fullPage: true });
  });

  test("an unlisted story opened directly says so honestly", async ({ page }) => {
    await page.goto(`./#/story/${world().unlistedId}`);
    await expect(page.getByTestId("story-unlisted")).toContainText("can't be erased");
  });
});
