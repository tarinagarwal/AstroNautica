import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import sodium from "libsodium-wrappers-sumo";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Minimal `--flag value` / `--switch` parser; positional args in `_`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[k] = true;
      else {
        out[k] = out[k] === undefined ? next : [].concat(out[k], next);
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

export function devConfig() {
  const p = join(repoRoot, ".dev/config.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

export function list(v, fallback = []) {
  if (v === undefined || v === true) return fallback;
  return []
    .concat(v)
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read a passphrase from OWNER_PASSPHRASE or the terminal (input not echoed). */
export async function askPassphrase(prompt = "Passphrase: ") {
  if (process.env.OWNER_PASSPHRASE) return process.env.OWNER_PASSPHRASE;
  if (!process.stdin.isTTY) throw new Error("no terminal: set OWNER_PASSPHRASE");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.includes(prompt)) rl.output.write(prompt);
  };
  const answer = await new Promise((r) => rl.question(prompt, r));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

/**
 * Encrypt a secret with a passphrase: Argon2id (libsodium crypto_pwhash, "sensitive" limits) + XSalsa20-Poly1305.
 * Returns a JSON-serialisable object.
 */
export async function encryptSecret(secret, passphrase) {
  await sodium.ready;
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const ops = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  const mem = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
  const key = sodium.crypto_pwhash(32, passphrase, salt, ops, mem, sodium.crypto_pwhash_ALG_ARGON2ID13);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(secret, nonce, key);
  return {
    format: "azaadawaaz/encrypted-secret@1",
    kdf: { alg: "argon2id13", ops, mem, salt: sodium.to_hex(salt) },
    nonce: sodium.to_hex(nonce),
    box: sodium.to_hex(box),
  };
}

export async function decryptSecret(obj, passphrase) {
  await sodium.ready;
  if (obj?.format !== "azaadawaaz/encrypted-secret@1") throw new Error("not an encrypted AzaadAwaaz secret");
  const key = sodium.crypto_pwhash(
    32,
    passphrase,
    sodium.from_hex(obj.kdf.salt),
    obj.kdf.ops,
    obj.kdf.mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return sodium.crypto_secretbox_open_easy(sodium.from_hex(obj.box), sodium.from_hex(obj.nonce), key);
  } catch {
    throw new Error("wrong passphrase or corrupted file");
  }
}

/** Load the owner's Nostr secret key from an encrypted key file. */
export async function loadOwnerSecret(path) {
  const obj = JSON.parse(readFileSync(path, "utf8"));
  const secret = await decryptSecret(obj.nostr ?? obj, await askPassphrase("Owner key passphrase: "));
  return secret;
}
