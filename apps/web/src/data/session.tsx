/** Unlocked keys for the contributor and moderator areas, held in memory only for this tab. */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { EncryptionKeyPair } from "@core/staging.js";
import type { Signer } from "../lib/signer.js";

export interface ModeratorSession {
  signer: Signer;
  x25519: EncryptionKeyPair;
}

interface Session {
  contributor: Signer | null;
  moderator: ModeratorSession | null;
  setContributor(s: Signer | null): void;
  setModerator(s: ModeratorSession | null): void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [contributor, setContributor] = useState<Signer | null>(null);
  const [moderator, setModerator] = useState<ModeratorSession | null>(null);
  const value = useMemo(() => ({ contributor, moderator, setContributor, setModerator }), [contributor, moderator]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
