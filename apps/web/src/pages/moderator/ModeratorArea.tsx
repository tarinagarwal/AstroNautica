import { useState, type FormEvent } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { keyPairFromSecret, parseSecretKey } from "@core/keys.js";
import { encryptionPublicKey } from "@core/staging.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useApp } from "../../data/context.js";
import { useSession } from "../../data/session.js";
import { useT } from "../../i18n/index.js";
import { saveVault } from "../../lib/vault.js";
import { localSigner } from "../../lib/signer.js";
import { PassphraseFields, VaultGate } from "../../components/KeyLogin.js";
import { Queue } from "./Queue.js";
import { Review } from "./Review.js";
import { Tools } from "./Tools.js";
import { Jobs } from "./Jobs.js";
import { Owner } from "./Owner.js";

interface ModSecrets {
  secret: string;
  x25519: string;
}

function Setup({ done }: { done: () => void }) {
  const t = useT();
  const [nsec, setNsec] = useState("");
  const [x, setX] = useState("");
  const [pass, setPass] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pass) return;
    setError(undefined);
    let kp;
    try {
      kp = keyPairFromSecret(parseSecretKey(nsec));
    } catch {
      return setError(t("keys.invalid"));
    }
    const xpriv = x.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(xpriv)) return setError(t("mod.x25519Invalid"));
    await saveVault(
      "moderator",
      kp.pubkey,
      { secret: bytesToHex(kp.secretKey), x25519: xpriv } satisfies ModSecrets,
      pass,
    );
    setNsec("");
    setX("");
    done();
  };
  return (
    <form className="card-form" onSubmit={(e) => void submit(e)}>
      <h2>{t("login.importTitle")}</h2>
      <p className="small">{t("mod.loginHelp")}</p>
      <label htmlFor="m-nsec">{t("login.nsec")}</label>
      <input id="m-nsec" type="password" autoComplete="off" value={nsec} onChange={(e) => setNsec(e.target.value)} />
      <label htmlFor="m-x">{t("mod.x25519")}</label>
      <input id="m-x" type="password" autoComplete="off" value={x} onChange={(e) => setX(e.target.value)} />
      <PassphraseFields value="" onChange={setPass} />
      <button type="submit" disabled={!nsec || !x || !pass}>
        {t("login.save")}
      </button>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

export default function ModeratorArea() {
  const t = useT();
  const app = useApp();
  const { moderator, setModerator } = useSession();
  const [warning, setWarning] = useState<string>();

  if (!moderator) {
    return (
      <div className="page narrow">
        <h1>{t("mod.title")}</h1>
        <p>{t("mod.intro")}</p>
        <VaultGate<ModSecrets>
          name="moderator"
          onUnlock={async (s) => {
            const signer = localSigner(hexToBytes(s.secret));
            const publicKey = await encryptionPublicKey(s.x25519);
            const lists = app.lists;
            const entry = lists?.moderators.find((m) => m.pubkey === signer.pubkey);
            const ownerKey = lists?.serviceKeys.find((k) => k.role === "owner" && k.pubkey === signer.pubkey);
            const listed = entry?.x25519 ?? ownerKey?.x25519;
            if (signer.pubkey !== app.owner && !lists?.activeModerators.has(signer.pubkey))
              setWarning(t("mod.notListed"));
            else if (listed && listed !== publicKey) setWarning(t("mod.x25519Mismatch"));
            else setWarning(undefined);
            setModerator({ signer, x25519: { publicKey, privateKey: s.x25519 } });
          }}
          setup={(done) => <Setup done={done} />}
        />
      </div>
    );
  }

  const isOwner = moderator.signer.pubkey === app.owner;
  return (
    <div className="page area">
      <div className="area-head">
        <h1>{isOwner ? t("mod.ownerTitle") : t("mod.title")}</h1>
        <p className="small muted mono break">{moderator.signer.npub}</p>
        {warning && <p className="banner warn">{warning}</p>}
        <nav className="subnav">
          <NavLink to="/moderate" end>
            {t("mod.queue")}
          </NavLink>
          <NavLink to="/moderate/tools">{t("mod.tools")}</NavLink>
          <NavLink to="/moderate/jobs">{t("mod.jobs")}</NavLink>
          {isOwner && <NavLink to="/moderate/owner">{t("mod.owner")}</NavLink>}
          <button type="button" className="link" onClick={() => setModerator(null)}>
            {t("login.lock")}
          </button>
        </nav>
      </div>
      <Routes>
        <Route index element={<Queue />} />
        <Route path="review/:id" element={<Review />} />
        <Route path="tools" element={<Tools />} />
        <Route path="jobs" element={<Jobs />} />
        {isOwner && <Route path="owner" element={<Owner />} />}
      </Routes>
    </div>
  );
}
