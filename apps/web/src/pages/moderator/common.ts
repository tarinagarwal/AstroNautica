import { useMemo } from "react";
import { useApp } from "../../data/context.js";
import { useSession, type ModeratorSession } from "../../data/session.js";
import { Api, ApiError } from "../../lib/api.js";

/** The moderator session (always present inside the moderator area) and an authenticated API client. */
export function useMod(): { mod: ModeratorSession; api: Api; sk: Uint8Array; me: string } {
  const app = useApp();
  const { moderator } = useSession();
  if (!moderator?.signer.secretKey) throw new Error("moderator area used without a session");
  const api = useMemo(() => new Api(app.config.apiUrl, moderator.signer), [app.config.apiUrl, moderator.signer]);
  return { mod: moderator, api, sk: moderator.signer.secretKey, me: moderator.signer.pubkey };
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return `${e.message} (${e.code})`;
  return e instanceof Error ? e.message : String(e);
}
