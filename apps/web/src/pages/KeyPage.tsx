import { useEffect, useState, type FormEvent } from "react";
import { useT } from "../i18n/index.js";
import {
  ensureReaderKey,
  forgetReaderKey,
  getReaderKey,
  importReaderKey,
  markBackedUp,
  onReaderKeyChange,
} from "../lib/readerKey.js";

/** Reader key management: export (nsec), import, backup status (spec §3, §7). */
export default function KeyPage() {
  const t = useT();
  const [key, setKey] = useState<Awaited<ReturnType<typeof getReaderKey>>>();
  const [reveal, setReveal] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    const load = () => void getReaderKey().then(setKey);
    load();
    return onReaderKeyChange(load);
  }, []);

  const doImport = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await importReaderKey(input);
      setInput("");
    } catch {
      setError(t("keys.invalid"));
    }
  };

  return (
    <div className="page prose">
      <h1>{t("keys.title")}</h1>
      <p>{t("keys.backupHelp")}</p>
      {key ? (
        <>
          <p>
            {t("keys.public")}{" "}
            <code className="mono break" data-testid="reader-npub">
              {key.npub}
            </code>
          </p>
          {!key.backedUp && <p className="banner warn">{t("keys.notBackedUp")}</p>}
          {!reveal ? (
            <button type="button" onClick={() => setReveal(true)}>
              {t("keys.export")}
            </button>
          ) : (
            <div className="secret">
              <p className="small">{t("keys.secretWarning")}</p>
              <code className="mono break" data-testid="reader-nsec">
                {key.nsec}
              </code>
              <p>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(key.nsec).catch(() => {});
                  }}
                >
                  {t("keys.copy")}
                </button>{" "}
                <button type="button" onClick={() => void markBackedUp()}>
                  {t("keys.saved")}
                </button>
              </p>
            </div>
          )}
          <p>
            {!confirmForget ? (
              <button type="button" className="link danger" onClick={() => setConfirmForget(true)}>
                {t("keys.forget")}
              </button>
            ) : (
              <span>
                {t("keys.forgetConfirm")}{" "}
                <button
                  type="button"
                  className="danger"
                  onClick={() => void forgetReaderKey().then(() => setConfirmForget(false))}
                >
                  {t("keys.forget")}
                </button>
              </span>
            )}
          </p>
        </>
      ) : (
        <>
          <p className="muted">{t("keys.none")}</p>
          <button type="button" onClick={() => void ensureReaderKey()}>
            {t("keys.create")}
          </button>
        </>
      )}
      <h2>{t("keys.import")}</h2>
      <form onSubmit={(e) => void doImport(e)}>
        <label htmlFor="nsec">{t("keys.importLabel")}</label>
        <input id="nsec" type="password" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} />
        <button type="submit" disabled={!input.trim()}>
          {t("keys.import")}
        </button>
        {error && <p className="error small">{error}</p>}
      </form>
    </div>
  );
}
