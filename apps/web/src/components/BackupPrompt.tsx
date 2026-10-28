import { Link } from "react-router-dom";
import { useT } from "../i18n/index.js";

/** Shown once after the reader key is created silently (spec §7: "offers a backup"). */
export function BackupPrompt({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div className="banner info" role="status" data-testid="backup-prompt">
      <strong>{t("keys.backup")}</strong>
      <p>{t("keys.backupHelp")}</p>
      <p>
        <Link to="/key">{t("keys.backupNow")}</Link>{" "}
        <button type="button" className="link" onClick={onClose}>
          {t("common.later")}
        </button>
      </p>
    </div>
  );
}
