import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createInvite } from "@core/auth.js";
import { hexToNpub } from "@core/keys.js";
import { useI18n } from "../../i18n/index.js";
import type { AlertItem, AuditRow } from "../../lib/api.js";
import { errorText, useMod } from "./common.js";

/** The link a contributor opens: this site's address plus `#/invite/<signed invite>` (never sent to a server). */
export function inviteLink(encoded: string, base = `${location.origin}${location.pathname}`): string {
  return `${base}#/invite/${encoded}`;
}

function InviteQr({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let c = false;
    void import("qrcode").then((QR) => {
      if (!c && ref.current) void QR.toCanvas(ref.current, text, { errorCorrectionLevel: "M", margin: 2, width: 280 });
    });
    return () => {
      c = true;
    };
  }, [text]);
  return <canvas ref={ref} className="qr" data-testid="invite-qr" />;
}

function Invites() {
  const { t } = useI18n();
  const { sk, api } = useMod();
  const [note, setNote] = useState("");
  const [days, setDays] = useState("14");
  const [link, setLink] = useState<string>();
  const [inviteId, setInviteId] = useState("");
  const [msg, setMsg] = useState<string>();
  const create = (e: FormEvent) => {
    e.preventDefault();
    const d = Number(days);
    const expiresAt = Number.isFinite(d) && d > 0 ? Math.floor(Date.now() / 1000) + Math.round(d * 86400) : undefined;
    const inv = createInvite(sk, { note: note.trim() || undefined, expiresAt });
    setLink(inviteLink(inv.link));
    setNote("");
  };
  const revoke = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.revokeInvite(inviteId.trim());
      setMsg(t("owner.inviteRevoked"));
      setInviteId("");
    } catch (err) {
      setMsg(errorText(err));
    }
  };
  return (
    <section>
      <h2>{t("owner.invites")}</h2>
      <form className="card-form" onSubmit={create}>
        <label htmlFor="inv-note">{t("owner.inviteNote")}</label>
        <input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} />
        <label htmlFor="inv-days">{t("owner.inviteDays")}</label>
        <input id="inv-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        <button type="submit">{t("owner.createInvite")}</button>
      </form>
      {link && (
        <div className="invite-out" data-testid="invite-link">
          <p className="small">{t("owner.inviteShare")}</p>
          <InviteQr text={link} />
          <code className="mono break small">{link}</code>
          <p>
            <button
              type="button"
              className="secondary"
              onClick={() => void navigator.clipboard?.writeText(link).catch(() => {})}
            >
              {t("keys.copy")}
            </button>
          </p>
        </div>
      )}
      <form className="card-form" onSubmit={(e) => void revoke(e)}>
        <label htmlFor="inv-id">{t("owner.revokeInvite")}</label>
        <input id="inv-id" value={inviteId} onChange={(e) => setInviteId(e.target.value)} />
        <button type="submit" className="danger" disabled={!inviteId.trim()}>
          {t("common.apply")}
        </button>
        {msg && <p className="small">{msg}</p>}
      </form>
    </section>
  );
}

function Alerts() {
  const { t, date } = useI18n();
  const { api } = useMod();
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.alerts().then(setAlerts, (e: unknown) => {
      setAlerts([]);
      setError(errorText(e));
    });
  }, [api]);
  useEffect(load, [load]);
  return (
    <section data-testid="alerts">
      <h2>{t("owner.alerts")}</h2>
      {error && <p className="error small">{error}</p>}
      {alerts?.length === 0 && !error && <p className="muted">{t("owner.noAlerts")}</p>}
      <ul className="list">
        {alerts?.map((a) => (
          <li key={a.id}>
            <strong>{t(`alert.${a.kind}`) === `alert.${a.kind}` ? a.kind : t(`alert.${a.kind}`)}</strong>{" "}
            <span className="muted small">· {date(a.createdAt, true)}</span>
            <pre className="small mono break">{JSON.stringify(a.detail, null, 1)}</pre>
          </li>
        ))}
      </ul>
      {alerts && alerts.length > 0 && (
        <button
          type="button"
          className="secondary"
          onClick={() => void api.alertsSeen(alerts.map((a) => a.id)).then(load)}
        >
          {t("owner.markSeen")}
        </button>
      )}
    </section>
  );
}

function AuditLog() {
  const { t, date } = useI18n();
  const { api } = useMod();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<string | undefined | null>(undefined);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (before?: string) => {
      try {
        const r = await api.auditLog(before);
        const items = Array.isArray(r) ? r : r.items;
        setRows((prev) => (before ? [...prev, ...items] : items));
        const last = items[items.length - 1];
        setNext(Array.isArray(r) ? (items.length ? last?.createdAt : null) : (r.next ?? null));
      } catch (e) {
        setError(errorText(e));
      }
    },
    [api],
  );
  useEffect(() => void load(), [load]);
  return (
    <section data-testid="audit">
      <h2>{t("owner.audit")}</h2>
      {error && <p className="error small">{error}</p>}
      <table className="audit">
        <thead>
          <tr>
            <th>{t("owner.when")}</th>
            <th>{t("owner.who")}</th>
            <th>{t("owner.what")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small">{date(r.createdAt, true)}</td>
              <td className="mono small">{hexToNpub(r.actor).slice(0, 14)}…</td>
              <td>{t(`audit.${r.action}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {next && (
        <button type="button" className="secondary" onClick={() => void load(next)}>
          {t("owner.more")}
        </button>
      )}
    </section>
  );
}

/** Owner extras: alerts (every unlisting raises one), the audit log, invites. */
export function Owner() {
  return (
    <div className="owner">
      <Alerts />
      <Invites />
      <AuditLog />
    </div>
  );
}
