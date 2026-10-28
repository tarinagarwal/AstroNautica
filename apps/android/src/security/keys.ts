/**
 * The keys this device holds (spec §3, §8.2): an optional reader key for comments and reactions, a contributor key
 * (created when an invite is redeemed), and a moderator's Nostr key plus X25519 key. All live in the vault (Android
 * Keystore, plus the PIN layer when an app lock is set). Contributor and moderator keys require an app lock.
 */
import {
  generateKeyPair,
  keyPairFromSecret,
  parseSecretKey,
  encryptionPublicKey,
  type EncryptionKeyPair,
  type KeyPair,
} from "@azaadawaaz/core";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface VaultState {
  hasVault: boolean;
  lock: "none" | "pin";
  biometric: boolean;
  biometricAvailable: boolean;
  unlocked: boolean;
  failedAttempts: number;
  retryAt: number;
}

export interface VaultBackend {
  state(): Promise<string>;
  write(secretsJson: string): Promise<void>;
  read(): Promise<string>;
  setPin(pin: string): Promise<void>;
  removePin(): Promise<void>;
  unlockWithPin(pin: string): Promise<string>;
  enableBiometric(title: string, subtitle: string, cancel: string): Promise<boolean>;
  disableBiometric(): Promise<void>;
  unlockWithBiometric(title: string, subtitle: string, cancel: string): Promise<boolean>;
  lock(): void;
  wipe(): Promise<void>;
}

export interface Secrets {
  reader?: string;
  contributor?: string;
  moderator?: { nostr: string; x25519: string };
  /** Content keys of submissions in progress (draft id → base64). */
  contentKeys?: Record<string, string>;
}

export class LockRequiredError extends Error {
  constructor() {
    super("set an app lock first");
    this.name = "LockRequiredError";
  }
}

export class KeyRing {
  private secrets: Secrets | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly vault: VaultBackend) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  async state(): Promise<VaultState> {
    return JSON.parse(await this.vault.state()) as VaultState;
  }

  get loaded(): boolean {
    return this.secrets !== null;
  }

  /** Read the secrets (the vault must be unlocked when a lock is set). */
  async load(): Promise<Secrets> {
    this.secrets = JSON.parse(await this.vault.read()) as Secrets;
    if (this.secrets.moderator) await this.loadModerator();
    this.emit();
    return this.secrets;
  }

  /** Forget the secrets in memory and lock the vault. */
  lock(): void {
    this.secrets = null;
    this.vault.lock();
    this.emit();
  }

  private async save(next: Secrets): Promise<void> {
    await this.vault.write(JSON.stringify(next));
    this.secrets = next;
    this.emit();
  }

  private current(): Secrets {
    if (!this.secrets) throw new Error("keys are locked");
    return this.secrets;
  }

  /** Whether the keys held require an app lock (contributor or moderator keys). */
  static lockRequired(s: Secrets | null): boolean {
    return !!(s?.contributor || s?.moderator);
  }

  reader(): KeyPair | undefined {
    const h = this.secrets?.reader;
    return h ? keyPairFromSecret(hexToBytes(h)) : undefined;
  }

  /** The reader key, created silently on first use (spec §7). */
  async ensureReader(): Promise<KeyPair> {
    const have = this.reader();
    if (have) return have;
    const kp = generateKeyPair();
    await this.save({ ...this.current(), reader: bytesToHex(kp.secretKey) });
    return kp;
  }

  async importReader(nsecOrHex: string): Promise<KeyPair> {
    const sk = parseSecretKey(nsecOrHex);
    await this.save({ ...this.current(), reader: bytesToHex(sk) });
    return keyPairFromSecret(sk);
  }

  contributor(): KeyPair | undefined {
    const h = this.secrets?.contributor;
    return h ? keyPairFromSecret(hexToBytes(h)) : undefined;
  }

  async setContributor(secretKey: Uint8Array): Promise<void> {
    if ((await this.state()).lock === "none") throw new LockRequiredError();
    await this.save({ ...this.current(), contributor: bytesToHex(secretKey) });
  }

  moderator(): { keys: KeyPair; x25519: EncryptionKeyPair } | undefined {
    const m = this.secrets?.moderator;
    if (!m || !this.x25519Cache || this.x25519Cache.privateKey !== m.x25519) return undefined;
    return { keys: keyPairFromSecret(hexToBytes(m.nostr)), x25519: this.x25519Cache };
  }

  private x25519Cache?: EncryptionKeyPair;

  async loadModerator(): Promise<{ keys: KeyPair; x25519: EncryptionKeyPair } | undefined> {
    const m = this.secrets?.moderator;
    if (!m) return undefined;
    this.x25519Cache = { privateKey: m.x25519, publicKey: await encryptionPublicKey(m.x25519) };
    return this.moderator();
  }

  async setModerator(nsecOrHex: string, x25519PrivateHex: string): Promise<{ pubkey: string; x25519: string }> {
    if ((await this.state()).lock === "none") throw new LockRequiredError();
    const sk = parseSecretKey(nsecOrHex);
    const x = x25519PrivateHex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(x)) throw new Error("the encryption key must be 64 hex characters");
    await this.save({ ...this.current(), moderator: { nostr: bytesToHex(sk), x25519: x } });
    const mod = await this.loadModerator();
    return { pubkey: mod!.keys.pubkey, x25519: mod!.x25519.publicKey };
  }

  async forget(role: "reader" | "contributor" | "moderator"): Promise<void> {
    const next = { ...this.current() };
    delete next[role];
    await this.save(next);
  }

  contentKey(draftId: string): string | undefined {
    return this.secrets?.contentKeys?.[draftId];
  }

  async setContentKey(draftId: string, keyB64: string | undefined): Promise<void> {
    const cur = this.current();
    const contentKeys = { ...(cur.contentKeys ?? {}) };
    if (keyB64) contentKeys[draftId] = keyB64;
    else delete contentKeys[draftId];
    await this.save({ ...cur, contentKeys });
  }

  // ---- lock management (delegates to the vault) ----
  setPin = (pin: string) => this.vault.setPin(pin);
  removePin = async () => {
    if (KeyRing.lockRequired(this.secrets)) throw new LockRequiredError();
    await this.vault.removePin();
  };
  unlockWithPin = async (pin: string) =>
    JSON.parse(await this.vault.unlockWithPin(pin)) as { ok: boolean; attemptsLeft: number; retryAt: number };
  enableBiometric = (t: string, s: string, c: string) => this.vault.enableBiometric(t, s, c);
  disableBiometric = () => this.vault.disableBiometric();
  unlockWithBiometric = (t: string, s: string, c: string) => this.vault.unlockWithBiometric(t, s, c);
  wipe = async () => {
    await this.vault.wipe();
    this.secrets = null;
    this.emit();
  };
}

/** PINs: 6 to 12 digits. */
export function validPin(pin: string): boolean {
  return /^\d{6,12}$/.test(pin);
}
