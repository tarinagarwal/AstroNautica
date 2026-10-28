import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DEFAULT_LIMITS, type StoryLanguage } from "@azaadawaaz/schema";
import { useApp } from "../../data/context.js";
import { useI18n } from "../../i18n/index.js";
import { Api, ApiError } from "../../lib/api.js";
import type { Signer } from "../../lib/signer.js";
import { Markdown } from "../../components/StoryView.js";
import {
  emptyText,
  loadDraft,
  loadMediaBytes,
  newDraft,
  saveDraft,
  saveMediaBytes,
  validateDraft,
  type Bilingual,
  type Draft,
  type DraftBlock,
} from "./draft.js";
import { MediaRejectedError, prepareMedia } from "./mediaPrep.js";
import { RecipientsError, uploadAndSubmit, type UploadProgress } from "./upload.js";

const LIMITS = { maxImageBytes: 20 * 1024 * 1024, maxVideoBytes: 2 * 1024 * 1024 * 1024 };

function BilingualField({
  id,
  label,
  value,
  language,
  onChange,
  multiline,
  maxChars,
  rows,
}: {
  id: string;
  label: string;
  value: Bilingual;
  language: StoryLanguage;
  onChange: (v: Bilingual) => void;
  multiline?: boolean;
  maxChars?: number;
  rows?: number;
}) {
  const { t } = useI18n();
  const langs = language === "both" ? (["en", "hi"] as const) : ([language] as const);
  return (
    <div className="field">
      {langs.map((l) => {
        const fid = `${id}-${l}`;
        const len = [...value[l]].length;
        return (
          <div key={l} className="field-lang">
            <label htmlFor={fid}>
              {label} {langs.length > 1 && <span className="muted small">({t(`lang.${l}`)})</span>}
            </label>
            {multiline ? (
              <textarea
                id={fid}
                lang={l}
                rows={rows ?? 4}
                value={value[l]}
                onChange={(e) => onChange({ ...value, [l]: e.target.value })}
              />
            ) : (
              <input id={fid} lang={l} value={value[l]} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />
            )}
            {maxChars && (
              <span className={"small " + (len > maxChars ? "error" : "muted")}>
                {t("editor.chars", { count: len, max: maxChars })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MediaThumb({ sha, mime }: { sha: string; mime: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let u: string | undefined;
    let c = false;
    void loadMediaBytes(sha).then((b) => {
      if (!b || c) return;
      u = URL.createObjectURL(new Blob([b as BlobPart], { type: mime }));
      setUrl(u);
    });
    return () => {
      c = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [sha, mime]);
  if (!url) return <div className="thumb" />;
  return mime.startsWith("video/") ? (
    <video className="thumb" src={url} muted playsInline />
  ) : (
    <img className="thumb" src={url} alt="" />
  );
}

function StrippedBadge() {
  const { t } = useI18n();
  return (
    <span className="ok small" data-testid="metadata-removed">
      {t("editor.metadataRemoved")}
    </span>
  );
}

export function Editor({ signer }: { signer: Signer }) {
  const { storyId, version } = useParams();
  const app = useApp();
  const { t } = useI18n();
  const nav = useNavigate();
  const [d, setD] = useState<Draft>();
  const [preview, setPreview] = useState<Record<number, boolean>>({});
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaError, setMediaError] = useState<string>();
  const [progress, setProgress] = useState<UploadProgress>();
  const [submitError, setSubmitError] = useState<string>();
  const [showErrors, setShowErrors] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (storyId && version) void loadDraft(storyId, Number(version)).then((x) => setD(x ?? newDraft()));
    else setD(newDraft());
  }, [storyId, version]);

  const update = useCallback((fn: (d: Draft) => Draft) => {
    setD((prev) => {
      if (!prev) return prev;
      const next = { ...fn(prev), updatedAt: Date.now() };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveDraft(next), 400);
      return next;
    });
  }, []);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const validation = useMemo(() => (d ? validateDraft(d, signer.npub, DEFAULT_LIMITS) : null), [d, signer.npub]);

  if (!d) return <p className="muted">{t("common.loading")}</p>;
  const L = d.language;

  const setBlock = (i: number, b: DraftBlock) =>
    update((x) => ({ ...x, blocks: x.blocks.map((y, j) => (j === i ? b : y)) }));
  const moveBlock = (i: number, dir: -1 | 1) =>
    update((x) => {
      const blocks = [...x.blocks];
      const j = i + dir;
      if (j < 0 || j >= blocks.length) return x;
      [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
      return { ...x, blocks };
    });
  const removeBlock = (i: number) => update((x) => ({ ...x, blocks: x.blocks.filter((_, j) => j !== i) }));
  const addBlock = (b: DraftBlock) => update((x) => ({ ...x, blocks: [...x.blocks, b] }));

  /** Strip metadata on this device, keep the clean bytes locally, return their hashes. */
  const addFiles = async (files: FileList | null, kind: "image" | "video"): Promise<string[]> => {
    if (!files?.length) return [];
    setMediaBusy(true);
    setMediaError(undefined);
    const out: string[] = [];
    try {
      for (const f of Array.from(files)) {
        try {
          const m = await prepareMedia(f, LIMITS);
          if (m.kind !== kind) throw new MediaRejectedError("unsupported", [m.mime]);
          await saveMediaBytes(m.sha256, m.bytes, m.mime);
          update((x) => ({
            ...x,
            media: {
              ...x.media,
              [m.sha256]: { sha256: m.sha256, mime: m.mime, size: m.bytes.length, kind: m.kind, name: f.name },
            },
          }));
          out.push(m.sha256);
        } catch (e) {
          const reason =
            e instanceof MediaRejectedError
              ? t(`editor.reject.${e.reason}`, { detail: e.detail.join(", ") })
              : String(e);
          setMediaError(`${f.name}: ${reason}`);
        }
      }
    } finally {
      setMediaBusy(false);
    }
    return out;
  };

  const submit = async () => {
    setShowErrors(true);
    setSubmitError(undefined);
    if (!validation?.ok || !app.lists) return;
    try {
      await saveDraft(d);
      const api = new Api(app.config.apiUrl, signer);
      await uploadAndSubmit(d, signer.npub, api, app.lists, setProgress);
      nav("/contribute");
    } catch (e) {
      setProgress(undefined);
      setSubmitError(
        e instanceof RecipientsError
          ? t("editor.noRecipients")
          : e instanceof ApiError
            ? `${e.message} (${e.code})`
            : String(e),
      );
    }
  };

  const tagsText = d.tags.join(", ");
  const images = Object.values(d.media).filter((m) => m.kind === "image");

  return (
    <div className="editor" data-testid="editor">
      <h2>{d.version > 1 ? t("editor.correctionTitle", { version: d.version }) : t("editor.title")}</h2>
      <p className="small muted">{t("editor.autosave")}</p>

      <fieldset>
        <legend>{t("editor.language")}</legend>
        {(["en", "hi", "both"] as const).map((l) => (
          <label key={l} className="inline">
            <input type="radio" name="lang" checked={L === l} onChange={() => update((x) => ({ ...x, language: l }))} />{" "}
            {t(`editor.lang.${l}`)}
          </label>
        ))}
      </fieldset>

      <BilingualField
        id="title"
        label={t("editor.storyTitle")}
        value={d.title}
        language={L}
        onChange={(v) => update((x) => ({ ...x, title: v }))}
        maxChars={DEFAULT_LIMITS.maxTitleChars}
      />
      <BilingualField
        id="summary"
        label={t("editor.summary")}
        value={d.summary}
        language={L}
        multiline
        rows={3}
        maxChars={DEFAULT_LIMITS.maxSummaryChars}
        onChange={(v) => update((x) => ({ ...x, summary: v }))}
      />
      <div className="field">
        <label htmlFor="tags">{t("editor.tags")}</label>
        <input
          id="tags"
          value={tagsText}
          onChange={(e) =>
            update((x) => ({
              ...x,
              tags: e.target.value
                .split(",")
                .map((s) => s.trimStart())
                .slice(0, 20),
            }))
          }
        />
        <span
          className={"small " + (d.tags.filter((x) => x.trim()).length > DEFAULT_LIMITS.maxTags ? "error" : "muted")}
        >
          {t("editor.tagsHelp", { max: DEFAULT_LIMITS.maxTags })}
        </span>
      </div>
      <BilingualField
        id="location"
        label={t("editor.location")}
        value={d.location}
        language={L}
        onChange={(v) => update((x) => ({ ...x, location: v }))}
      />
      <p className="small muted">{t("editor.locationHelp")}</p>
      <div className="field">
        <label htmlFor="pen">{t("editor.penName")}</label>
        <input
          id="pen"
          value={d.displayName}
          placeholder={t("story.defaultContributor")}
          onChange={(e) => update((x) => ({ ...x, displayName: e.target.value }))}
        />
      </div>

      <fieldset>
        <legend>{t("editor.cover")}</legend>
        {d.coverSha && d.media[d.coverSha] && (
          <div className="media-row">
            <MediaThumb sha={d.coverSha} mime={d.media[d.coverSha]!.mime} />
            <StrippedBadge />
            <button type="button" className="link" onClick={() => update((x) => ({ ...x, coverSha: null }))}>
              {t("editor.remove")}
            </button>
          </div>
        )}
        {images.length > 0 && (
          <div className="field">
            <label htmlFor="cover-pick">{t("editor.coverFromStory")}</label>
            <select
              id="cover-pick"
              value={d.coverSha ?? ""}
              onChange={(e) => update((x) => ({ ...x, coverSha: e.target.value || null }))}
            >
              <option value="">{t("editor.noCover")}</option>
              {images.map((m) => (
                <option key={m.sha256} value={m.sha256}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="file">
          {t("editor.uploadCover")}
          <input
            type="file"
            accept="image/*"
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              void addFiles(e.target.files, "image").then((s) => s[0] && update((x) => ({ ...x, coverSha: s[0]! })))
            }
          />
        </label>
      </fieldset>

      <h3>{t("editor.blocks")}</h3>
      {d.blocks.length === 0 && <p className="muted">{t("editor.noBlocks")}</p>}
      <ol className="blocks">
        {d.blocks.map((b, i) => (
          <li key={i} className="block-edit" data-testid={`block-${b.type}`}>
            <div className="block-bar">
              <strong>{t(`editor.block.${b.type}`)}</strong>
              <span>
                <button
                  type="button"
                  className="link"
                  disabled={i === 0}
                  onClick={() => moveBlock(i, -1)}
                  aria-label={t("editor.moveUp")}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={i === d.blocks.length - 1}
                  onClick={() => moveBlock(i, 1)}
                  aria-label={t("editor.moveDown")}
                >
                  ↓
                </button>
                <button type="button" className="link danger" onClick={() => removeBlock(i)}>
                  {t("editor.remove")}
                </button>
              </span>
            </div>
            {b.type === "text" && (
              <>
                <BilingualField
                  id={`text-${i}`}
                  label={t("editor.markdown")}
                  value={b.markdown}
                  language={L}
                  multiline
                  rows={8}
                  onChange={(v) => setBlock(i, { ...b, markdown: v })}
                />
                <button type="button" className="link" onClick={() => setPreview((p) => ({ ...p, [i]: !p[i] }))}>
                  {preview[i] ? t("editor.hidePreview") : t("editor.showPreview")}
                </button>
                {preview[i] && (
                  <div className="md-preview">
                    {(L === "both" ? (["en", "hi"] as const) : [L]).map((l) => (
                      <Markdown key={l} text={b.markdown[l]} lang={l} />
                    ))}
                  </div>
                )}
              </>
            )}
            {b.type === "image" && (
              <>
                {b.items.map((it, j) => (
                  <div key={it.sha256 + j} className="media-row">
                    {d.media[it.sha256] && <MediaThumb sha={it.sha256} mime={d.media[it.sha256]!.mime} />}
                    <StrippedBadge />
                    <BilingualField
                      id={`cap-${i}-${j}`}
                      label={t("editor.caption")}
                      value={it.caption}
                      language={L}
                      onChange={(v) =>
                        setBlock(i, { ...b, items: b.items.map((x, k) => (k === j ? { ...x, caption: v } : x)) })
                      }
                    />
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => setBlock(i, { ...b, items: b.items.filter((_, k) => k !== j) })}
                    >
                      {t("editor.remove")}
                    </button>
                  </div>
                ))}
                {b.items.length < DEFAULT_LIMITS.maxImagesPerBlock && (
                  <label className="file">
                    {t("editor.addImages")}
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) =>
                        void addFiles(e.target.files, "image").then((shas) =>
                          update((x) => ({
                            ...x,
                            blocks: x.blocks.map((y, k) =>
                              k === i && y.type === "image"
                                ? {
                                    ...y,
                                    items: [
                                      ...y.items,
                                      ...shas.map((s) => ({ sha256: s, caption: emptyText() })),
                                    ].slice(0, DEFAULT_LIMITS.maxImagesPerBlock),
                                  }
                                : y,
                            ),
                          })),
                        )
                      }
                    />
                  </label>
                )}
              </>
            )}
            {b.type === "video" && (
              <>
                {b.sha256 && d.media[b.sha256] ? (
                  <div className="media-row">
                    <MediaThumb sha={b.sha256} mime={d.media[b.sha256]!.mime} />
                    <StrippedBadge />
                  </div>
                ) : (
                  <label className="file">
                    {t("editor.chooseVideo")}
                    <input
                      type="file"
                      accept="video/mp4,video/quicktime,video/3gpp"
                      onChange={(e) =>
                        void addFiles(e.target.files, "video").then((s) => s[0] && setBlock(i, { ...b, sha256: s[0]! }))
                      }
                    />
                  </label>
                )}
                <BilingualField
                  id={`vt-${i}`}
                  label={t("editor.videoTitle")}
                  value={b.title}
                  language={L}
                  onChange={(v) => setBlock(i, { ...b, title: v })}
                />
                <BilingualField
                  id={`vd-${i}`}
                  label={t("editor.videoDescription")}
                  value={b.description}
                  language={L}
                  multiline
                  onChange={(v) => setBlock(i, { ...b, description: v })}
                />
              </>
            )}
            {b.type === "embed-story" && (
              <div className="field">
                <label htmlFor={`embed-${i}`}>{t("editor.embedId")}</label>
                <input
                  id={`embed-${i}`}
                  list="known-stories"
                  value={b.storyId}
                  onChange={(e) => setBlock(i, { ...b, storyId: e.target.value })}
                />
                <datalist id="known-stories">
                  {app.stories.map((s) => (
                    <option key={s.storyId} value={s.storyId}>
                      {s.title}
                    </option>
                  ))}
                </datalist>
                <label htmlFor={`embed-v-${i}`}>{t("editor.embedVersion")}</label>
                <input
                  id={`embed-v-${i}`}
                  inputMode="numeric"
                  value={b.version}
                  onChange={(e) => setBlock(i, { ...b, version: e.target.value })}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
      {mediaBusy && <p className="muted small">{t("editor.stripping")}</p>}
      {mediaError && (
        <p className="error small" role="alert">
          {mediaError}
        </p>
      )}
      <div className="add-blocks">
        <button type="button" className="secondary" onClick={() => addBlock({ type: "text", markdown: emptyText() })}>
          {t("editor.addText")}
        </button>
        <button type="button" className="secondary" onClick={() => addBlock({ type: "image", items: [] })}>
          {t("editor.addGallery")}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => addBlock({ type: "video", sha256: "", title: emptyText(), description: emptyText() })}
        >
          {t("editor.addVideo")}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => addBlock({ type: "embed-story", storyId: "", version: "" })}
        >
          {t("editor.addEmbed")}
        </button>
      </div>

      {showErrors && validation && !validation.ok && (
        <div className="banner warn" role="alert" data-testid="validation-errors">
          <strong>{t("editor.fixErrors")}</strong>
          <ul className="small">
            {validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="small">{t("editor.privacy")}</p>
      <button type="button" onClick={() => void submit()} disabled={!!progress || mediaBusy}>
        {progress
          ? t(`editor.progress.${progress.phase}`, { done: progress.done, total: progress.total })
          : t("editor.submit")}
      </button>
      {submitError && (
        <p className="error" role="alert">
          {submitError}
        </p>
      )}
    </div>
  );
}
