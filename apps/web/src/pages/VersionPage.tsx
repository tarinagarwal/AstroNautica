import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Lang, Manifest } from "@azaadawaaz/schema";
import { isSha256Hex, sha256Hex, validateManifest, manifestSha256 } from "@azaadawaaz/schema";
import { defaultStoryLang, storyLanguages } from "@core/i18n.js";
import { verifyApprovalSignature } from "@core/approval.js";
import { wasModeratorAt, wasPublisherAt } from "@core/lists.js";
import { useApp } from "../data/context.js";
import { useI18n } from "../i18n/index.js";
import { StoryBody, StoryHeader } from "../components/StoryView.js";
import { StoryLangSwitch } from "./StoryPage.js";
import { findPublishedCid, publisherWindows } from "../lib/eth.js";
import { arweaveLinks, gatewayLinks } from "../lib/gateways.js";

type State =
  | { kind: "loading" }
  | { kind: "missing"; cid?: string; tx?: string }
  | { kind: "invalid" }
  | { kind: "ok"; manifest: Manifest };

/**
 * An earlier version of a story, found by the hash in the newer version's `supersedes` (spec §6.5). Relays keep only
 * the latest story event, so the old manifest is located through its storage receipt (Arweave) or its chain receipt
 * (IPFS CID), fetched by hash and checked: canonical hash, schema, approval signature and moderator.
 */
export default function VersionPage() {
  const { id = "", sha = "" } = useParams();
  const app = useApp();
  const { t, lang: uiLang, date } = useI18n();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [storyLang, setStoryLang] = useState<Lang>();
  const ready = !!app.lists && app.listsStatus !== "loading";

  useEffect(() => {
    if (!ready || !isSha256Hex(sha)) {
      if (!isSha256Hex(sha)) setState({ kind: "invalid" });
      return;
    }
    let c = false;
    (async () => {
      const current = await app.getStory(id);
      const latestVersion = current?.ref.version ?? 1;
      const versions = Array.from({ length: Math.max(0, latestVersion - 1) }, (_, i) => i + 1);
      const receipts = await app.storageReceipts(id, versions);
      const receipt = receipts.find((r) => r.manifestSha256 === sha);
      const tx = receipt?.arweave[sha];
      let cid: string | undefined;
      for (const v of receipt ? [receipt.version] : versions.reverse()) {
        const found = await findPublishedCid(
          app.config.chains,
          id,
          v,
          publisherWindows(app.lists?.serviceKeys ?? []),
        ).catch(() => undefined);
        if (found && found.sha === sha) {
          cid = found.cid;
          break;
        }
      }
      let bytes: Uint8Array;
      try {
        bytes = await app.fetchManifestBytes(sha, cid, tx);
      } catch {
        if (!c) setState({ kind: "missing", cid, tx });
        return;
      }
      const lists = app.lists!;
      let m: Manifest;
      try {
        m = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        if (!c) setState({ kind: "invalid" });
        return;
      }
      const ok =
        sha256Hex(bytes) === sha &&
        validateManifest(m).ok &&
        manifestSha256(m) === sha &&
        m.id === id &&
        verifyApprovalSignature(m, m.approval) &&
        wasModeratorAt(lists, m.approval.moderator, Math.floor(Date.parse(m.approval.approvedAt) / 1000)) &&
        wasPublisherAt(lists, m.publisher, Math.floor(Date.parse(m.publishedAt) / 1000), sha);
      if (!c) setState(ok ? { kind: "ok", manifest: m } : { kind: "invalid" });
    })();
    return () => {
      c = true;
    };
  }, [app, id, sha, ready]);

  if (state.kind === "loading") return <p className="muted pad">{t("story.loading")}</p>;
  if (state.kind === "invalid")
    return (
      <p className="error pad" role="alert">
        {t("verify.failed")}
      </p>
    );
  if (state.kind === "missing") {
    return (
      <div className="page" data-testid="version-missing">
        <p>{t("version.notFound")}</p>
        <p>
          {t("verify.manifestHash")}: <code className="mono break">{sha}</code>
        </p>
        {state.cid && (
          <ul>
            {gatewayLinks(state.cid).map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noopener noreferrer">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        )}
        {state.tx && (
          <ul>
            {arweaveLinks(state.tx).map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noopener noreferrer">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="small muted">{t("version.checkYourself")}</p>
        <Link to={`/story/${id}`}>{t("version.latest")}</Link>
      </div>
    );
  }
  const m = state.manifest;
  const langs = storyLanguages(m.language);
  const lang = storyLang && langs.includes(storyLang) ? storyLang : defaultStoryLang(m.language, uiLang);
  return (
    <article className="page story" data-testid="version-page">
      <p className="banner info">
        {t("version.earlier", { version: m.version, date: date(m.publishedAt) })}{" "}
        <Link to={`/story/${id}`}>{t("version.latest")}</Link>
      </p>
      <StoryLangSwitch langs={langs} value={lang} onChange={setStoryLang} />
      <StoryHeader story={m} lang={lang} publishedAt={m.publishedAt} />
      {m.supersedes && (
        <p className="corrected">
          <Link to={`/story/${id}/version/${m.supersedes}`}>{t("story.previousVersion")}</Link>
        </p>
      )}
      <StoryBody story={m} lang={lang} />
    </article>
  );
}
