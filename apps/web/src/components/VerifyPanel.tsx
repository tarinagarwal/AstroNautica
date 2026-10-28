import { useEffect, useState } from "react";
import type { StoryRef } from "@core/stories.js";
import { useApp } from "../data/context.js";
import { useI18n } from "../i18n/index.js";
import { verifyStory, initialVerify, type CheckState, type VerifyResult } from "../data/verify.js";
import { arweaveLinks, gatewayLinks } from "../lib/gateways.js";
import { chainName, explorerTx } from "../lib/eth.js";

function Mark({ state }: { state: CheckState }) {
  const { t } = useI18n();
  const label = state === "ok" ? t("verify.pass") : state === "fail" ? t("verify.fail") : t("verify.checking");
  return (
    <span className={"mark " + state} role="img" aria-label={label} title={label}>
      {state === "ok" ? "✓" : state === "fail" ? "✗" : "…"}
    </span>
  );
}

const short = (s: string, n = 10) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export function VerifyPanel({ story }: { story: StoryRef }) {
  const app = useApp();
  const { t, date } = useI18n();
  const [r, setR] = useState<VerifyResult>(() => initialVerify(story));
  const [running, setRunning] = useState(true);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRunning(true);
    setR(initialVerify(story));
    verifyStory(app, story, (x) => !cancelled && setR(x)).finally(() => !cancelled && setRunning(false));
    return () => {
      cancelled = true;
    };
  }, [app, story, run]);

  const failed = !running && !r.allOk;
  const mc = r.manifest.check?.checks;
  return (
    <section className="verify" aria-labelledby="verify-h" data-testid="verify-panel">
      <h2 id="verify-h">{t("verify.title")}</h2>
      <p className={"verdict " + (r.allOk ? "ok" : failed ? "fail" : "pending")} data-testid="verify-verdict" role="status">
        {r.allOk ? `✓ ${t("verify.ok")}` : failed ? `✗ ${t("verify.failed")}` : t("verify.checking")}
      </p>
      <dl className="checks">
        <dt>
          <Mark state={r.event.state} /> {t("verify.publisher")}
        </dt>
        <dd className="mono">{short(story.publisher)}</dd>

        <dt>
          <Mark state={r.manifest.state} /> {t("verify.manifestHash")}
        </dt>
        <dd>
          <code className="mono break">{r.manifest.sha256}</code>
          {mc && (
            <ul className="sub">
              <li>
                <Mark state={mc.hash ? "ok" : "fail"} /> {t("verify.hashMatches")}
              </li>
              <li>
                <Mark state={mc.approvalSignature ? "ok" : "fail"} /> {t("verify.signature")}
              </li>
              <li>
                <Mark state={mc.moderatorAuthorised ? "ok" : "fail"} /> {t("verify.moderatorListed")}
              </li>
              <li>
                <Mark state={mc.publisherMatches && mc.matchesEvent ? "ok" : "fail"} /> {t("verify.matchesEvent")}
              </li>
            </ul>
          )}
        </dd>

        <dt>
          <Mark state={r.ipfs.state} /> {t("verify.ipfs")}
        </dt>
        <dd>
          <code className="mono break">{r.ipfs.cid}</code>
          {r.ipfs.gateway && <span className="muted small"> {t("verify.servedBy", { source: r.ipfs.gateway })}</span>}
          {r.ipfs.state === "fail" && <span className="error small"> {t("verify.ipfsFailed")}</span>}
          <span className="links">
            {gatewayLinks(r.ipfs.cid).slice(0, 3).map((u) => (
              <a key={u} href={u} target="_blank" rel="noopener noreferrer">
                {new URL(u).host}
              </a>
            ))}
          </span>
        </dd>

        <dt>
          <Mark state={r.arweave.state} /> {t("verify.arweave")}
        </dt>
        <dd>
          {r.arweave.tx ? <code className="mono break">{r.arweave.tx}</code> : null}
          {r.arweave.error === "no-receipt" && <span className="muted small">{t("verify.noReceipt")}</span>}
          {r.arweave.error === "no-gateway" && <span className="muted small">{t("verify.noArweaveGateway")}</span>}
          {r.arweave.error === "unreachable" && <span className="error small">{t("verify.arweaveFailed")}</span>}
          {r.arweave.tx && (
            <span className="links">
              {arweaveLinks(r.arweave.tx).slice(0, 2).map((u) => (
                <a key={u} href={u} target="_blank" rel="noopener noreferrer">
                  {new URL(u).host}
                </a>
              ))}
            </span>
          )}
        </dd>

        <dt>
          <Mark state={r.chains.state} /> {t("verify.chain")}
        </dt>
        <dd>
          {r.chains.error === "no-chains" && <span className="muted small">{t("verify.noChains")}</span>}
          <ul className="sub">
            {r.chains.receipts.map((c) => {
              const link = c.txHash ? explorerTx(c.chain, c.txHash) : undefined;
              return (
                <li key={c.chain.key} data-testid="chain-receipt">
                  <Mark state={c.ok ? "ok" : "fail"} /> <strong>{chainName(c.chain)}</strong>
                  {c.txHash &&
                    (link ? (
                      <a className="mono" href={link} target="_blank" rel="noopener noreferrer">
                        {" "}
                        {short(c.txHash, 8)}
                      </a>
                    ) : (
                      <code className="mono"> {short(c.txHash, 8)}</code>
                    ))}
                  {c.timestamp ? <span className="muted small"> · {date(c.timestamp, true)}</span> : null}
                  {c.error && <span className="error small"> · {t(`verify.chainError.${c.error}`)}</span>}
                </li>
              );
            })}
          </ul>
        </dd>
      </dl>
      {r.flagged.length > 0 && (
        <div className="flagged" role="alert" data-testid="source-flagged">
          <strong>{t("verify.sourceFlagged")}</strong>
          <ul>
            {r.flagged.map((f) => (
              <li key={f} className="mono">
                {f}
              </li>
            ))}
          </ul>
          <p className="small">{t("verify.sourceFlaggedHelp")}</p>
        </div>
      )}
      {r.manifest.check && r.manifest.check.errors.length > 0 && (
        <ul className="errors small">
          {r.manifest.check.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <button type="button" className="secondary" disabled={running} onClick={() => setRun((x) => x + 1)}>
        {t("verify.again")}
      </button>
    </section>
  );
}
