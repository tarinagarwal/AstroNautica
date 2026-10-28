import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { KIND_REDEMPTION, createRedemption, decodeInvite, verifyInvite } from "@core/auth.js";
import { generateKeyPair } from "@core/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Event } from "nostr-tools/pure";
import { useApp } from "../../data/context.js";
import { useSession } from "../../data/session.js";
import { useI18n } from "../../i18n/index.js";
import { Api, ApiError } from "../../lib/api.js";
import { saveVault } from "../../lib/vault.js";
import { localSigner, nip07Available, nip07Signer } from "../../lib/signer.js";
import { PassphraseFields } from "../../components/KeyLogin.js";

/**
 * Redeem an owner-signed invite (spec §3.1): a new key pair is created on this device (or the NIP-07 extension's
 * key is used), the contributor signs the redemption, and the API records it. The key is saved encrypted with a
 * passphrase.
 */
export default function InvitePage() {
  const { code = "" } = useParams();
  const app = useApp();
  const { t, date } = useI18n();
  const nav = useNavigate();
  const { setContributor } = useSession();
  const [pass, setPass] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const invite = useMemo(() => {
    try {
      const e = decodeInvite(code);
      return { event: e, check: verifyInvite(e, app.owner) };
    } catch {
      return null;
    }
  }, [code, app.owner]);

  if (!app.owner) return <p className="pad">{t("banner.noLists")}</p>;
  if (!invite || !invite.check.ok) {
    return (
      <div className="page">
        <h1>{t("invite.title")}</h1>
        <p className="error" role="alert" data-testid="invite-invalid">
          {t("invite.invalid")} {invite && !invite.check.ok ? `(${invite.check.error})` : ""}
        </p>
      </div>
    );
  }
  const content = invite.check.content;
  const api = new Api(app.config.apiUrl);

  const redeem = async (redemption: Event) => {
    try {
      await api.redeemInvite(redemption);
    } catch (e) {
      throw new Error(e instanceof ApiError ? `${e.message} (${e.code})` : String(e));
    }
  };

  const withNewKey = async () => {
    if (!pass) return;
    setBusy(true);
    setError(undefined);
    try {
      const kp = generateKeyPair();
      await redeem(createRedemption(invite.event, kp.secretKey));
      await saveVault("contributor", kp.pubkey, { secret: bytesToHex(kp.secretKey) }, pass);
      setContributor(localSigner(kp.secretKey));
      nav("/contribute");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const withExtension = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const signer = await nip07Signer();
      const redemption = await signer.sign({
        kind: KIND_REDEMPTION,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["e", invite.event.id]],
        content: JSON.stringify(invite.event),
      });
      await redeem(redemption);
      setContributor(signer);
      nav("/contribute");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow" data-testid="invite">
      <h1>{t("invite.title")}</h1>
      <p>{t("invite.valid")}</p>
      {content.note && (
        <p>
          <strong>{t("invite.note")}</strong> {content.note}
        </p>
      )}
      {content.expiresAt && (
        <p className="small muted">{t("invite.expires", { date: date(content.expiresAt, true) })}</p>
      )}
      <p className="small">{t("invite.privacy")}</p>
      <div className="card-form">
        <h2>{t("invite.newKey")}</h2>
        <PassphraseFields value="" onChange={setPass} />
        <button type="button" disabled={busy || !pass} onClick={() => void withNewKey()}>
          {busy ? t("common.working") : t("invite.redeem")}
        </button>
      </div>
      {nip07Available() && (
        <p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void withExtension()}>
            {t("invite.useExtension")}
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
