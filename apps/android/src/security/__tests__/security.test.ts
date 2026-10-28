import { generateKeyPair } from "@azaadawaaz/core";
import { KeyRing, LockRequiredError, validPin, type VaultBackend } from "../keys";
import { AUTO_LOCK_MS, backoffMs, mustLockOnResume, secondsUntilRetry } from "../lock";

/** The native vault's contract (Kotlin PinVault + Keystore), in memory. */
function memoryVault(): VaultBackend {
  let secrets = "{}";
  let pin: string | null = null;
  let unlocked = true;
  return {
    state: async () => JSON.stringify({ hasVault: true, lock: pin ? "pin" : "none", biometric: false, biometricAvailable: false, unlocked, failedAttempts: 0, retryAt: 0 }),
    write: async (s) => {
      if (!unlocked) throw new Error("locked");
      secrets = s;
    },
    read: async () => {
      if (!unlocked) throw new Error("the vault is locked");
      return secrets;
    },
    setPin: async (p) => {
      pin = p;
    },
    removePin: async () => {
      pin = null;
    },
    unlockWithPin: async (p) => {
      unlocked = p === pin;
      return JSON.stringify({ ok: unlocked, attemptsLeft: 4, retryAt: 0 });
    },
    enableBiometric: async () => false,
    disableBiometric: async () => undefined,
    unlockWithBiometric: async () => false,
    lock: () => {
      if (pin) unlocked = false;
    },
    wipe: async () => {
      secrets = "{}";
      pin = null;
    },
  };
}

describe("key ring", () => {
  it("creates the reader key silently and lets it be exported and imported", async () => {
    const k = new KeyRing(memoryVault());
    await k.load();
    expect(k.reader()).toBeUndefined();
    const r = await k.ensureReader();
    expect(k.reader()?.pubkey).toBe(r.pubkey);
    const other = generateKeyPair();
    expect((await k.importReader(other.nsec)).pubkey).toBe(other.pubkey);
  });

  it("requires an app lock before holding contributor or moderator keys", async () => {
    const vault = memoryVault();
    const k = new KeyRing(vault);
    await k.load();
    await expect(k.setContributor(generateKeyPair().secretKey)).rejects.toBeInstanceOf(LockRequiredError);
    await k.setPin("123456");
    await k.setContributor(generateKeyPair().secretKey);
    const mod = generateKeyPair();
    const x = "1f017bb62ede0d74182bf85c28220af6d0fd79a740e4f04e8a9fde0de6d932e7";
    const r = await k.setModerator(mod.nsec, x);
    expect(r.pubkey).toBe(mod.pubkey);
    expect(r.x25519).toBe("21b90312fc518c3503a2478443edccbfa77f42954c3776e201f65a8a2c463c3f");
    expect(KeyRing.lockRequired({ contributor: "x" })).toBe(true);
    await expect(k.removePin()).rejects.toBeInstanceOf(LockRequiredError);
    // locking drops every secret from memory; unlocking with the PIN brings them back
    k.lock();
    expect(k.loaded).toBe(false);
    expect((await k.unlockWithPin("000000")).ok).toBe(false);
    expect((await k.unlockWithPin("123456")).ok).toBe(true);
    await k.load();
    expect(k.moderator()?.keys.pubkey).toBe(mod.pubkey);
    await k.setContentKey("d1", "a2V5");
    expect(k.contentKey("d1")).toBe("a2V5");
    await expect(k.setModerator(mod.nsec, "zz")).rejects.toThrow(/64 hex/);
  });
});

describe("app lock policy", () => {
  it("locks after the background timeout and backs off like the native vault", () => {
    expect(mustLockOnResume(0, AUTO_LOCK_MS, true)).toBe(true);
    expect(mustLockOnResume(0, AUTO_LOCK_MS - 1, true)).toBe(false);
    expect(mustLockOnResume(0, AUTO_LOCK_MS, false)).toBe(false);
    expect(mustLockOnResume(null, 1e12, true)).toBe(false);
    expect([4, 5, 6, 40].map(backoffMs)).toEqual([0, 30_000, 60_000, 3_600_000]);
    expect(secondsUntilRetry(Date.now() + 1500)).toBe(2);
    expect(validPin("12345")).toBe(false);
    expect(validPin("1234567")).toBe(true);
  });
});
