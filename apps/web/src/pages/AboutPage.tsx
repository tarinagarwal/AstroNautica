import { Link } from "react-router-dom";
import { useT } from "../i18n/index.js";

export default function AboutPage() {
  const t = useT();
  return (
    <div className="page prose">
      <h1>{t("about.title")}</h1>
      <p>{t("about.p1")}</p>
      <p>{t("about.p2")}</p>
      <h2>{t("about.verifyTitle")}</h2>
      <p>{t("about.verify")}</p>
      <h2>{t("about.privacyTitle")}</h2>
      <p>{t("about.privacy")}</p>
      <h2>{t("about.commentsTitle")}</h2>
      <p>{t("about.comments")}</p>
      <p>
        <Link to="/reach">{t("nav.reach")}</Link>
      </p>
    </div>
  );
}
