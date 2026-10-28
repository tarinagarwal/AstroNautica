import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useT } from "../i18n/index.js";
import { loadVault, clearVault, unseal, type VaultName, type VaultRecord, WrongPassphraseError } from "../lib/vault.js";

/**
 * Unlock a passphrase-protected key from IndexedDB, or show `setup` to add one. Used by the contributor and
 * moderator areas; secrets are decrypted only into memory for this tab.
 */
export function VaultGate<T>({
  name,
  onUnlock,
  setup,
}: {
  name: VaultName;
  onUnlock: (secrets: T, record: VaultRecord) => void | Promise<void>;
  setup: (done: () => void) => ReactNode;
}) {
  const t = useT();
  const [record, setRecord] = useState<VaultRecord | null | undefined>(undefined);
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = () => void loadVault(name).then((r) => setRecord(r ?? null));
  useEffect(reload, [name]);

  if (record === undefined) return <p className="muted">{t("common.loading")}</p>;
  if (record === null) return <>{setup(reload)}</>;

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onUnlock(await unseal<T>(record.sealed, pass), record);
    } catch (err) {
      setError(
        err instanceof WrongPassphraseError
          ? t("login.wrongPassphrase")
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card-form" onSubmit={(e) => void unlock(e)}>
      <h2>{t("login.unlockTitle")}</h2>
      <p className="small muted mono break">{record.pubkey}</p>
      <label htmlFor="pass">{t("login.passphrase")}</label>
      <input
        id="pass"
        type="password"
        autoComplete="current-password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      <button type="submit" disabled={busy || !pass}>
        {busy ? t("login.unlocking") : t("login.unlock")}
      </button>
      {error && <p className="error small">{error}</p>}
      <p className="small">
        <button
          type="button"
          className="link danger"
          onClick={() => {
            if (window.confirm(t("login.forgetConfirm"))) void clearVault(name).then(reload);
          }}
        >
          {t("login.forget")}
        </button>
      </p>
    </form>
  );
}

/** Passphrase + confirmation inputs with a minimum length. */
export function PassphraseFields({ value, onChange }: { value: string; onChange: (ok: string | null) => void }) {
  const t = useT();
  const [a, setA] = useState(value);
  const [b, setB] = useState(value);
  useEffect(() => {
    onChange(a.length >= 10 && a === b ? a : null);
  }, [a, b, onChange]);
  return (
    <>
      <label htmlFor="pp1">{t("login.newPassphrase")}</label>
      <input id="pp1" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} />
      <label htmlFor="pp2">{t("login.repeatPassphrase")}</label>
      <input id="pp2" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} />
      {a.length > 0 && a.length < 10 && <p className="small error">{t("login.passphraseShort")}</p>}
      {b.length > 0 && a !== b && <p className="small error">{t("login.passphraseMismatch")}</p>}
    </>
  );
}
