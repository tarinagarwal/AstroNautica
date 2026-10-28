import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@azaadawaaz/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseSize } from "../src/config.js";

describe("config", () => {
  const owner = generateKeyPair();
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "api-config-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const base = { DATABASE_URL: "postgres://x@localhost/db", OWNER_PUBKEY: owner.npub, STAGING_DIR: "/srv/staging" };

  it("reads env vars with documented defaults", () => {
    const c = loadConfig(base, dir);
    expect(c).toMatchObject({
      port: 8787,
      publicUrls: ["http://127.0.0.1:8787"],
      basePath: "",
      ownerPubkey: owner.pubkey,
      stagingDir: "/srv/staging",
      relays: [],
      claimMinutes: 30,
      unlistPerHour: 5,
      rejectedRetentionDays: 30,
      maxImageBytes: 20 * 1024 * 1024,
      maxVideoBytes: 2 * 1024 ** 3,
      maxBlocks: 100,
      allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
      autoMigrate: true,
      maxSubmissionBytes: 4 * 1024 ** 3,
      maxContributorStagingBytes: 8 * 1024 ** 3,
      maxMediaPerSubmission: 200,
      draftRetentionDays: 30,
    });
  });

  it("reads the staging quotas and draft retention", () => {
    const c = loadConfig(
      {
        ...base,
        MAX_SUBMISSION_BYTES: "1GB",
        MAX_CONTRIBUTOR_STAGING_BYTES: "3GB",
        MAX_MEDIA_PER_SUBMISSION: "50",
        DRAFT_RETENTION_DAYS: "7",
      },
      dir,
    );
    expect(c.maxSubmissionBytes).toBe(1024 ** 3);
    expect(c.maxContributorStagingBytes).toBe(3 * 1024 ** 3);
    expect(c.maxMediaPerSubmission).toBe(50);
    expect(c.draftRetentionDays).toBe(7);
    expect(() => loadConfig({ ...base, DRAFT_RETENTION_DAYS: "0" }, dir)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MAX_MEDIA_PER_SUBMISSION: "0" }, dir)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MAX_SUBMISSION_BYTES: "lots" }, dir)).toThrow(ConfigError);
  });

  it("parses lists, sizes and a public URL with a path prefix", () => {
    const c = loadConfig(
      {
        ...base,
        PORT: "3000",
        PUBLIC_URL: "https://azaadawaaz.org/api/, http://abc.onion/api",
        RELAYS: "wss://r1.example, ws://127.0.0.1:7777",
        MAX_IMAGE_BYTES: "10MB",
        MAX_VIDEO_BYTES: "1073741824",
        ALLOWED_ORIGINS: "https://azaadawaaz.org",
        AUTO_MIGRATE: "false",
      },
      dir,
    );
    expect(c.port).toBe(3000);
    expect(c.publicUrls).toEqual(["https://azaadawaaz.org/api", "http://abc.onion/api"]);
    expect(c.basePath).toBe("/api");
    expect(c.relays).toEqual(["wss://r1.example", "ws://127.0.0.1:7777"]);
    expect(c.maxImageBytes).toBe(10 * 1024 * 1024);
    expect(c.maxVideoBytes).toBe(1073741824);
    expect(c.allowedOrigins).toEqual(["https://azaadawaaz.org"]);
    expect(c.autoMigrate).toBe(false);
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({ ...base, OWNER_PUBKEY: "nope" }, dir)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_URL: "" }, dir)).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, CLAIM_MINUTES: "-1" }, dir)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RELAYS: "http://x" }, dir)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PUBLIC_URL: "https://a/api,https://b/v2" }, dir)).toThrow(/same path/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: "https://a/?x=1" }, dir)).toThrow(ConfigError);
    expect(() => parseSize("X", "lots", 1)).toThrow(ConfigError);
    expect(parseSize("X", "2GB", 1)).toBe(2 * 1024 ** 3);
    expect(parseSize("X", undefined, 7)).toBe(7);
  });

  it("builds the database URL from docker-secret style parts and refuses TRUST_PROXY", async () => {
    const pw = join(dir, "pw");
    await writeFile(pw, "s3cr/t@x\n");
    const parts = {
      OWNER_PUBKEY: owner.pubkey,
      STAGING_DIR: "/srv/staging",
      DATABASE_HOST: "postgres",
      DATABASE_NAME: "azaadawaaz",
      DATABASE_USER: "azaad",
      DATABASE_PASSWORD_FILE: pw,
    };
    expect(loadConfig(parts, dir).databaseUrl).toBe("postgres://azaad:s3cr%2Ft%40x@postgres:5432/azaadawaaz");
    expect(loadConfig({ ...parts, TRUST_PROXY: "false" }, dir).databaseUrl).toContain("@postgres:5432/");
    expect(() => loadConfig({ ...parts, TRUST_PROXY: "true" }, dir)).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...parts, DATABASE_PASSWORD_FILE: join(dir, "missing") }, dir)).toThrow(ConfigError);
  });

  it("falls back to .dev/config.json found in a parent directory", async () => {
    const root = join(dir, "repo");
    await mkdir(join(root, ".dev"), { recursive: true });
    await mkdir(join(root, "services", "api"), { recursive: true });
    await writeFile(
      join(root, ".dev", "config.json"),
      JSON.stringify({
        ownerPubkey: owner.pubkey,
        relays: ["ws://127.0.0.1:7777", "ws://127.0.0.1:7778"],
        apiUrl: "http://127.0.0.1:8787",
        databaseUrl: "postgres://azaad:azaad@127.0.0.1:5432/azaadawaaz",
        stagingDir: ".dev/staging",
      }),
    );
    const c = loadConfig({}, join(root, "services", "api"));
    expect(c.ownerPubkey).toBe(owner.pubkey);
    expect(c.relays).toHaveLength(2);
    expect(c.databaseUrl).toContain("azaadawaaz");
    expect(c.stagingDir).toBe(join(root, ".dev", "staging"));
    // env vars win
    expect(loadConfig({ DATABASE_URL: "postgres://other/db" }, join(root, "services", "api")).databaseUrl).toBe(
      "postgres://other/db",
    );
  });
});
