import type { StoryRef } from "@azaadawaaz/core";
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { chainName } from "../../data/eth";
import { verifyStory, type CheckState, type VerifyResult, initialVerify } from "../../data/verify";
import { useServices } from "../context";
import { useI18n } from "../i18n";
import { colors, space } from "../theme";
import { Badge, Button, Card, Txt } from "./basic";

function Check({ state, label, detail }: { state: CheckState; label: string; detail?: string }) {
  const { t } = useI18n();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: space.m, gap: space.s }}>
      <Badge tone={state === "ok" ? "ok" : state === "fail" ? "bad" : "neutral"} label={state === "ok" ? "✓" : state === "fail" ? "✗" : "…"} />
      <View style={{ flex: 1 }}>
        <Txt bold>{label}</Txt>
        {detail ? (
          <Txt muted size={13} selectable>
            {detail}
          </Txt>
        ) : null}
        {state === "pending" ? (
          <Txt muted size={13}>
            {t("verify.checking")}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/** Every check runs live on this phone (spec §8.1); the green badge needs all of them. */
export function VerifyPanel({ story }: { story: StoryRef }) {
  const { app, http } = useServices();
  const { t, date } = useI18n();
  const [r, setR] = useState<VerifyResult>(() => initialVerify(story));
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    setR(initialVerify(story));
    void verifyStory(app, http, story, (x) => live && setR(x));
    return () => {
      live = false;
    };
  }, [app, http, story, run]);
  const done = [r.event, r.manifest, r.ipfs, r.arweave, r.chains].every((c) => c.state !== "pending");
  const m = r.manifest.check;
  return (
    <Card>
      <Txt bold size={20} style={{ marginBottom: space.m }}>
        {t("verify.title")}
      </Txt>
      <View style={{ padding: space.m, borderRadius: 8, marginBottom: space.l, backgroundColor: r.allOk ? colors.okBg : done ? colors.badBg : colors.code }}>
        <Txt bold>{r.allOk ? t("verify.ok") : done ? t("verify.failed") : t("verify.checking")}</Txt>
      </View>
      <Check state={r.event.state} label={t("verify.publisher")} detail={story.publisher} />
      <Check
        state={r.manifest.state}
        label={t("verify.manifestHash")}
        detail={[r.manifest.sha256, ...(m?.errors ?? [])].join("\n")}
      />
      {m ? (
        <Check state={m.checks.approvalSignature && m.checks.moderatorAuthorised ? "ok" : "fail"} label={t("verify.signature")} detail={m.manifest?.approval.moderator} />
      ) : null}
      <Check state={r.ipfs.state} label={t("verify.ipfs")} detail={[r.ipfs.cid, r.ipfs.gateway, r.ipfs.error].filter(Boolean).join("\n")} />
      <Check
        state={r.arweave.state}
        label={t("verify.arweave")}
        detail={r.arweave.tx ? [r.arweave.tx, r.arweave.gateway].filter(Boolean).join("\n") : r.arweave.error ? t(`verify.arweave.${r.arweave.error}`) : undefined}
      />
      <Check state={r.chains.state} label={t("verify.chain")} detail={r.chains.error === "no-chains" ? t("verify.noChains") : undefined} />
      {r.chains.receipts.map((c) => (
        <View key={c.chain.key} style={{ marginLeft: space.xl, marginBottom: space.s }}>
          <Txt size={14} bold>
            {chainName(c.chain)}: {c.ok ? "✓" : `✗ ${t(`verify.chainError.${c.error ?? "unreachable"}`)}`}
          </Txt>
          {c.txHash ? (
            <Txt muted size={12} selectable>
              {c.txHash}
              {c.timestamp ? ` · ${date(c.timestamp, true)}` : ""}
            </Txt>
          ) : null}
        </View>
      ))}
      {r.flagged.length ? (
        <View style={{ marginTop: space.m }}>
          <Txt bold>{t("verify.flagged")}</Txt>
          {r.flagged.map((f) => (
            <Txt key={f} muted size={13}>
              {f}
            </Txt>
          ))}
        </View>
      ) : null}
      {done ? <Button kind="secondary" title={t("verify.again")} onPress={() => setRun((x) => x + 1)} /> : null}
    </Card>
  );
}
