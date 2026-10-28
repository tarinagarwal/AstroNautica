import type { AndroidRelease, WebRelease } from "@core/lists.js";
import { useApp } from "../data/context.js";
import { gatewayLinks } from "../lib/gateways.js";
import { useI18n } from "../i18n/index.js";

const TOR_BROWSER = "https://www.torproject.org/download/";

function host(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/**
 * "How to reach us when blocked" (spec §10), in simple English and Hindi. Everything listed comes from owner-signed
 * lists: mirror domains (Telegram links and IPFS copies are mirror entries too), onion addresses and app releases.
 */
export default function ReachPage() {
  const app = useApp();
  const { t, num } = useI18n();
  const lists = app.lists;
  const mirrors = lists?.mirrors ?? [];
  const telegram = mirrors.filter((m) => /^(t\.me|telegram\.me)$/.test(host(m.url)));
  const ipfs = mirrors.filter((m) => /\/ip[fn]s\//.test(m.url));
  const domains = mirrors.filter((m) => !telegram.includes(m) && !ipfs.includes(m));
  const releases = [...(lists?.releases ?? [])].sort((a, b) => b.versionCode - a.versionCode);
  const apk = releases.find((r): r is AndroidRelease => r.platform === "android");
  const web = releases.find((r): r is WebRelease => r.platform === "web");
  const ipfsCopies = [...ipfs.map((m) => m.url), ...(web ? gatewayLinks(web.cid).map((u) => u + "/") : [])];
  return (
    <div className="page prose" data-testid="reach">
      <h1>{t("reach.title")}</h1>
      <p>{t("reach.intro")}</p>

      <h2>{t("reach.domains")}</h2>
      <p>{t("reach.domainsHelp")}</p>
      {domains.length ? (
        <ul>
          {domains.map((m) => (
            <li key={m.url}>
              <a href={m.url} rel="noopener noreferrer">
                {host(m.url)}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("reach.noneListed")}</p>
      )}

      <h2>{t("reach.onion")}</h2>
      <p>{t("reach.onionHelp")}</p>
      {lists?.onions.length ? (
        <ul>
          {lists.onions.map((o) => (
            <li key={o.address}>
              <code className="mono break">{`http://${o.address}`}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("reach.noneListed")}</p>
      )}
      <p>
        <a href={TOR_BROWSER} target="_blank" rel="noopener noreferrer">
          {t("reach.getTor")}
        </a>
      </p>

      <h2>{t("reach.app")}</h2>
      <p>{t("reach.appHelp")}</p>
      {apk ? (
        <div className="release">
          <p>{t("reach.appVersion", { version: apk.version, size: num(Math.round(apk.size / 1024 / 1024)) })}</p>
          <ul>
            {apk.urls.map((u) => (
              <li key={u}>
                <a href={u} rel="noopener noreferrer" download>
                  {t("reach.download", { host: host(u) })}
                </a>
              </li>
            ))}
          </ul>
          <p className="small">
            {t("reach.appCheck")} <code className="mono break">{apk.sha256}</code>
          </p>
        </div>
      ) : (
        <p className="muted">{t("reach.noneListed")}</p>
      )}

      <h2>{t("reach.telegram")}</h2>
      <p>{t("reach.telegramHelp")}</p>
      {telegram.length ? (
        <ul>
          {telegram.map((m) => (
            <li key={m.url}>
              <a href={m.url} target="_blank" rel="noopener noreferrer">
                {m.url.replace(/^https?:\/\//, "")}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("reach.noneListed")}</p>
      )}

      {ipfsCopies.length > 0 && (
        <>
          <h2>{t("reach.ipfs")}</h2>
          <p>{t("reach.ipfsHelp")}</p>
          <ul>
            {ipfsCopies.map((u) => (
              <li key={u}>
                <a href={u} rel="noopener noreferrer">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="small muted">{t("reach.signed")}</p>
    </div>
  );
}
