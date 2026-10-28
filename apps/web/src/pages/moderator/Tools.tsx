import { useState, type FormEvent } from "react";
import { toPubkeyHex } from "@core/keys.js";
import { useApp } from "../../data/context.js";
import { useT } from "../../i18n/index.js";
import {
  changeList,
  createAuditEvent,
  hideComment,
  muteKey,
  unlistStory,
  type ModResult,
} from "../../data/moderation.js";
import { errorText, useMod } from "./common.js";
import { rewrapAll } from "./actions.js";

function Action({
  id,
  label,
  help,
  placeholder,
  run,
  danger,
}: {
  id: string;
  label: string;
  help?: string;
  placeholder?: string;
  run: (v: string) => Promise<string>;
  danger?: boolean;
}) {
  const t = useT();
  const [v, setV] = useState("");
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    try {
      setMsg(await run(v.trim()));
      setV("");
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card-form" onSubmit={(e) => void submit(e)}>
      <label htmlFor={id}>{label}</label>
      {help && <p className="small muted">{help}</p>}
      <input id={id} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
      <button type="submit" className={danger ? "danger" : ""} disabled={busy || !v.trim()}>
        {busy ? t("common.working") : t("common.apply")}
      </button>
      {msg && <p className="small">{msg}</p>}
    </form>
  );
}

/** List-based moderation (hide, mute, unlist), contributor list sync and key re-wrapping. */
export function Tools() {
  const t = useT();
  const app = useApp();
  const { api, sk, me, mod } = useMod();
  const [syncMsg, setSyncMsg] = useState<string>();
  const [rewrapMsg, setRewrapMsg] = useState<string>();

  const summary = (r: ModResult) =>
    t("moderate.listPublished", { ok: r.relays.filter((x) => x.ok).length, total: r.relays.length }) +
    (r.auditError ? " " + t("moderate.auditFailed", { error: r.auditError }) : "");

  const syncContributors = async () => {
    setSyncMsg(t("common.working"));
    try {
      const rows = await api.contributors();
      const active = rows.filter((r) => !r.revokedAt).map((r) => r.pubkey);
      const revoked = rows.filter((r) => r.revokedAt).map((r) => r.pubkey);
      const a = await changeList(
        app,
        sk,
        me,
        "contributors",
        active.map((value) => ({ op: "add" as const, value })),
      );
      if (revoked.length)
        await changeList(
          app,
          sk,
          me,
          "revoked-contributors",
          revoked.map((value) => ({ op: "add" as const, value })),
        );
      setSyncMsg(
        t("mod.syncDone", { active: active.length, revoked: revoked.length, ok: a.relays.filter((x) => x.ok).length }),
      );
    } catch (e) {
      setSyncMsg(errorText(e));
    }
  };

  const rewrap = async () => {
    setRewrapMsg(t("common.working"));
    try {
      if (!app.lists) throw new Error(t("banner.noLists"));
      const r = await rewrapAll(api, app.lists, mod.x25519);
      setRewrapMsg(t("mod.rewrapDone", { done: r.done, failed: r.failed.length }));
    } catch (e) {
      setRewrapMsg(errorText(e));
    }
  };

  return (
    <section className="tools" data-testid="mod-tools">
      <h2>{t("mod.tools")}</h2>
      <Action
        id="hide"
        label={t("moderate.hideComment")}
        help={t("mod.hideHelp")}
        run={async (v) => summary(await hideComment(app, api, sk, me, v))}
      />
      <Action
        id="mute"
        label={t("moderate.muteKey")}
        help={t("mod.muteHelp")}
        run={async (v) => summary(await muteKey(app, api, sk, me, toPubkeyHex(v)))}
      />
      <Action
        id="unlist"
        label={t("moderate.unlist")}
        help={t("moderate.unlistHonest")}
        danger
        run={async (v) => summary(await unlistStory(app, api, sk, me, v))}
      />
      <Action
        id="revoke"
        label={t("mod.revokeContributor")}
        help={t("mod.revokeHelp")}
        danger
        run={async (v) => {
          const pubkey = toPubkeyHex(v);
          const audit = createAuditEvent(sk, "revoke_contributor", { extraTags: [["p", pubkey]] });
          await api.revokeContributor(pubkey, audit);
          const r = await changeList(app, sk, me, "revoked-contributors", [{ op: "add", value: pubkey }]);
          return t("moderate.listPublished", { ok: r.relays.filter((x) => x.ok).length, total: r.relays.length });
        }}
      />
      <div className="card-form">
        <h3>{t("mod.syncContributors")}</h3>
        <p className="small muted">{t("mod.syncHelp")}</p>
        <button type="button" onClick={() => void syncContributors()}>
          {t("mod.syncNow")}
        </button>
        {syncMsg && <p className="small">{syncMsg}</p>}
      </div>
      <div className="card-form">
        <h3>{t("mod.rewrap")}</h3>
        <p className="small muted">{t("mod.rewrapHelp")}</p>
        <button type="button" onClick={() => void rewrap()}>
          {t("mod.rewrapNow")}
        </button>
        {rewrapMsg && <p className="small">{rewrapMsg}</p>}
      </div>
    </section>
  );
}
