import { useState, type FormEvent } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { parseSecretKey, keyPairFromSecret } from "@core/keys.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useSession } from "../../data/session.js";
import { useT } from "../../i18n/index.js";
import { saveVault } from "../../lib/vault.js";
import { localSigner, nip07Available, nip07Signer } from "../../lib/signer.js";
import { PassphraseFields, VaultGate } from "../../components/KeyLogin.js";
import { Editor } from "./Editor.js";
import { MySubmissions } from "./MySubmissions.js";

function ImportKey({ done }: { done: () => void }) {
  const t = useT();
  const [nsec, setNsec] = useState("");
  const [pass, setPass] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pass) return;
    try {
      const kp = keyPairFromSecret(parseSecretKey(nsec));
      await saveVault("contributor", kp.pubkey, { secret: bytesToHex(kp.secretKey) }, pass);
      setNsec("");
      done();
    } catch {
      setError(t("keys.invalid"));
    }
  };
  return (
    <form className="card-form" onSubmit={(e) => void submit(e)}>
      <h2>{t("login.importTitle")}</h2>
      <p className="small">{t("contrib.loginHelp")}</p>
      <label htmlFor="c-nsec">{t("login.nsec")}</label>
      <input id="c-nsec" type="password" autoComplete="off" value={nsec} onChange={(e) => setNsec(e.target.value)} />
      <PassphraseFields value="" onChange={setPass} />
      <button type="submit" disabled={!nsec || !pass}>
        {t("login.save")}
      </button>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

function Login() {
  const t = useT();
  const { setContributor } = useSession();
  const [error, setError] = useState<string>();
  return (
    <div className="page narrow">
      <h1>{t("contrib.title")}</h1>
      <p>{t("contrib.intro")}</p>
      <VaultGate<{ secret: string }>
        name="contributor"
        onUnlock={(s) => setContributor(localSigner(hexToBytes(s.secret)))}
        setup={(done) => <ImportKey done={done} />}
      />
      {nip07Available() && (
        <p>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void nip07Signer().then(setContributor, (e: unknown) =>
                setError(e instanceof Error ? e.message : String(e)),
              )
            }
          >
            {t("login.extension")}
          </button>
        </p>
      )}
      {error && <p className="error small">{error}</p>}
      <p className="small muted">{t("contrib.inviteHelp")}</p>
    </div>
  );
}

export default function ContributorArea() {
  const t = useT();
  const { contributor, setContributor } = useSession();
  if (!contributor) return <Login />;
  return (
    <div className="page area">
      <div className="area-head">
        <h1>{t("contrib.title")}</h1>
        <p className="small muted mono break">{contributor.npub}</p>
        <nav className="subnav">
          <NavLink to="/contribute" end>
            {t("contrib.mine")}
          </NavLink>
          <NavLink to="/contribute/new">{t("contrib.new")}</NavLink>
          <button type="button" className="link" onClick={() => setContributor(null)}>
            {t("login.lock")}
          </button>
        </nav>
      </div>
      <Routes>
        <Route index element={<MySubmissions signer={contributor} />} />
        <Route path="new" element={<Editor signer={contributor} />} />
        <Route path="edit/:storyId/:version" element={<Editor signer={contributor} />} />
      </Routes>
    </div>
  );
}
