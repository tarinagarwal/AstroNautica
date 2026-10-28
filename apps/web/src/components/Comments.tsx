import { useMemo, useState, type FormEvent } from "react";
import { buildCommentThread, commentTemplate, MAX_COMMENT_CHARS, type CommentNode } from "@core/social.js";
import type { StoryRef } from "@core/stories.js";
import { hexToNpub } from "@core/keys.js";
import type { Event, EventTemplate } from "nostr-tools/pure";
import { useI18n } from "../i18n/index.js";
import { useApp } from "../data/context.js";
import { useSession } from "../data/session.js";
import { hideComment, muteKey } from "../data/moderation.js";
import { Api } from "../lib/api.js";
import { BackupPrompt } from "./BackupPrompt.js";

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Plain text with clickable http(s) links; never HTML. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

type Post = (t: EventTemplate) => Promise<{ event: Event; createdKey: boolean; accepted: number }>;

function CommentForm({
  story,
  parent,
  post,
  onDone,
}: {
  story: StoryRef;
  parent?: Event;
  post: Post;
  onDone: (createdKey: boolean) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const len = [...text].length;
  const tooLong = len > MAX_COMMENT_CHARS;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || tooLong) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await post(commentTemplate({ story, content: text, parent }));
      if (r.accepted === 0) setError(t("comments.notAccepted"));
      else {
        setText("");
        onDone(r.createdKey);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="comment-form" onSubmit={(e) => void submit(e)}>
      <label className="sr-only" htmlFor={parent ? `reply-${parent.id}` : "new-comment"}>
        {t("comments.placeholder")}
      </label>
      <textarea
        id={parent ? `reply-${parent.id}` : "new-comment"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("comments.placeholder")}
        rows={parent ? 2 : 3}
        disabled={busy}
      />
      <div className="form-row">
        <span className={"small " + (tooLong ? "error" : "muted")}>
          {t("comments.chars", { count: len, max: MAX_COMMENT_CHARS })}
        </span>
        <button type="submit" disabled={busy || !text.trim() || tooLong}>
          {busy ? t("comments.posting") : parent ? t("comments.reply") : t("comments.post")}
        </button>
      </div>
      {tooLong && <p className="error small">{t("comments.tooLong", { max: MAX_COMMENT_CHARS })}</p>}
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

function CommentItem({
  node,
  story,
  post,
  onPosted,
  depth,
}: {
  node: CommentNode;
  story: StoryRef;
  post: Post;
  onPosted: (k: boolean) => void;
  depth: number;
}) {
  const { t, date } = useI18n();
  const app = useApp();
  const { moderator } = useSession();
  const [replying, setReplying] = useState(false);
  const [modMsg, setModMsg] = useState<string>();
  const e = node.event;
  const npub = hexToNpub(e.pubkey);
  const moderate = async (what: "hide" | "mute") => {
    if (!moderator?.signer.secretKey) return;
    const api = app.config.apiUrl ? new Api(app.config.apiUrl, moderator.signer) : null;
    const fn = what === "hide" ? hideComment : muteKey;
    const r = await fn(
      app,
      api,
      moderator.signer.secretKey,
      moderator.signer.pubkey,
      what === "hide" ? e.id : e.pubkey,
    );
    setModMsg(r.auditError ? t("moderate.auditFailed", { error: r.auditError }) : t("moderate.done"));
  };
  return (
    <li className="comment" data-testid="comment">
      <div className="comment-head">
        <span className="mono small" title={npub}>
          {npub.slice(0, 12)}…
        </span>
        <span className="muted small"> · {date(e.created_at, true)}</span>
      </div>
      <p className="comment-text">
        <Linkified text={e.content} />
      </p>
      <div className="comment-actions">
        {depth < 6 && (
          <button type="button" className="link" onClick={() => setReplying((x) => !x)}>
            {t("comments.reply")}
          </button>
        )}
        {moderator && (
          <>
            <button type="button" className="link danger" onClick={() => void moderate("hide")}>
              {t("moderate.hideComment")}
            </button>
            <button type="button" className="link danger" onClick={() => void moderate("mute")}>
              {t("moderate.muteKey")}
            </button>
          </>
        )}
      </div>
      {modMsg && <p className="small muted">{modMsg}</p>}
      {replying && (
        <CommentForm
          story={story}
          parent={e}
          post={post}
          onDone={(k) => {
            setReplying(false);
            onPosted(k);
          }}
        />
      )}
      {node.replies.length > 0 && (
        <ul className="replies">
          {node.replies.map((r) => (
            <CommentItem key={r.event.id} node={r} story={story} post={post} onPosted={onPosted} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Comments({
  story,
  events,
  loaded,
  post,
}: {
  story: StoryRef;
  events: Event[];
  loaded: boolean;
  post: Post;
}) {
  const { t } = useI18n();
  const app = useApp();
  const [backup, setBackup] = useState(false);
  const lists = app.lists;
  const thread = useMemo(
    () => (lists ? buildCommentThread(events, story.address, lists, app.config.powDifficulty) : []),
    [events, story.address, lists, app.config.powDifficulty],
  );
  const count = useMemo(() => {
    const n = (xs: CommentNode[]): number => xs.reduce((s, x) => s + 1 + n(x.replies), 0);
    return n(thread);
  }, [thread]);
  const onPosted = (createdKey: boolean) => setBackup(createdKey);
  return (
    <section className="comments" aria-labelledby="comments-h" data-testid="comments">
      <h2 id="comments-h">
        {t("comments.title")}{" "}
        <span className="muted small">({count === 1 ? t("comments.countOne") : t("comments.count", { count })})</span>
      </h2>
      {backup && <BackupPrompt onClose={() => setBackup(false)} />}
      <CommentForm story={story} post={post} onDone={onPosted} />
      {loaded && thread.length === 0 && <p className="muted">{t("comments.empty")}</p>}
      {!loaded && <p className="muted">{t("common.loading")}</p>}
      <ul className="thread">
        {thread.map((n) => (
          <CommentItem key={n.event.id} node={n} story={story} post={post} onPosted={onPosted} depth={0} />
        ))}
      </ul>
    </section>
  );
}
