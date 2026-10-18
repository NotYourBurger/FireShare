import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configProblems,
  describeConfigProblems,
  loadAccessConfig,
  loadCleanupConfig,
  loadConfig,
  loadExpiryConfig,
  loadLimitsConfig,
  loadTransferConfig,
  loadUploadConfig,
} from "./config";

describe("transfer config", () => {
  it("defaults to proxy mode without requiring a direct endpoint", () => {
    const proxy = { mode: "proxy", directEndpoint: null, appOrigin: null, directNetworks: null };
    expect(loadTransferConfig({})).toEqual(proxy);
    expect(loadTransferConfig({ TRANSFER_MODE: "proxy" })).toEqual(proxy);
  });

  it("reads the HTTPS direct endpoint and optional app origin for direct and auto modes", () => {
    expect(
      loadTransferConfig({
        TRANSFER_MODE: "direct",
        STORAGE_DIRECT_ENDPOINT: "https://storage.lan.example.com:9443/",
        APP_ORIGIN: "https://share.example.com",
      }),
    ).toEqual({
      mode: "direct",
      directEndpoint: "https://storage.lan.example.com:9443",
      appOrigin: "https://share.example.com",
      directNetworks: null,
    });
    expect(
      loadTransferConfig({
        TRANSFER_MODE: "auto",
        STORAGE_DIRECT_ENDPOINT: "https://storage.lan.example.com/s3",
        DIRECT_NETWORKS: "192.168.1.0/24",
      }),
    ).toMatchObject({
      mode: "auto",
      directEndpoint: "https://storage.lan.example.com/s3",
      appOrigin: null,
    });
  });

  it.each(["direct", "auto"])("refuses to start in %s mode when STORAGE_DIRECT_ENDPOINT is missing", (mode) => {
    const networks = mode === "auto" ? { DIRECT_NETWORKS: "192.168.1.0/24" } : {};
    expect(() => loadTransferConfig({ TRANSFER_MODE: mode, ...networks })).toThrow(/^Missing STORAGE_DIRECT_ENDPOINT/);
    expect(() => loadTransferConfig({ TRANSFER_MODE: mode, STORAGE_DIRECT_ENDPOINT: "  ", ...networks })).toThrow(
      /^Missing STORAGE_DIRECT_ENDPOINT/,
    );
  });

  it("reads DIRECT_NETWORKS in auto mode", () => {
    const { directNetworks } = loadTransferConfig({
      TRANSFER_MODE: "auto",
      STORAGE_DIRECT_ENDPOINT: "https://storage.lan.example.com",
      DIRECT_NETWORKS: "192.168.1.0/24, 10.8.0.0/16, fd00::/8",
    });
    expect(["192.168.1.20", "10.8.3.4", "fd00::1", "::ffff:192.168.1.7"].map((ip) => directNetworks!.has(ip))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["192.168.2.1", "203.0.113.5", "2001:db8::1"].some((ip) => directNetworks!.has(ip))).toBe(false);
  });

  it.each([undefined, "", "  "])("refuses to start in auto mode when DIRECT_NETWORKS is %j", (networks) => {
    expect(() =>
      loadTransferConfig({
        TRANSFER_MODE: "auto",
        STORAGE_DIRECT_ENDPOINT: "https://storage.lan.example.com",
        DIRECT_NETWORKS: networks,
      }),
    ).toThrow(/^Missing DIRECT_NETWORKS/);
  });

  it("names a bad DIRECT_NETWORKS entry", () => {
    expect(() =>
      loadTransferConfig({
        TRANSFER_MODE: "auto",
        STORAGE_DIRECT_ENDPOINT: "https://storage.lan.example.com",
        DIRECT_NETWORKS: "192.168.1.0/24,lan",
      }),
    ).toThrow(/^Invalid DIRECT_NETWORKS entry "lan"/);
  });

  it.each([
    { TRANSFER_MODE: "proxy" },
    { TRANSFER_MODE: "direct", STORAGE_DIRECT_ENDPOINT: "https://storage.lan.example.com" },
  ])("refuses DIRECT_NETWORKS outside auto mode (%j)", (env) => {
    expect(() => loadTransferConfig({ ...env, DIRECT_NETWORKS: "192.168.1.0/24" })).toThrow(
      /^DIRECT_NETWORKS is set but TRANSFER_MODE=(proxy|direct) would ignore it/,
    );
  });

  it.each([
    "http://storage.lan.example.com",
    "http://localhost:9000",
    "ftp://storage.lan.example.com",
    "storage.lan.example.com",
    "https://user:pass@storage.lan.example.com",
    "https://storage.lan.example.com?x=1",
    "https://storage.lan.example.com#frag",
  ])("rejects a non-HTTPS or malformed STORAGE_DIRECT_ENDPOINT=%s", (endpoint) => {
    expect(() => loadTransferConfig({ TRANSFER_MODE: "direct", STORAGE_DIRECT_ENDPOINT: endpoint })).toThrow(
      /^Invalid STORAGE_DIRECT_ENDPOINT/,
    );
    expect(() => loadTransferConfig({ TRANSFER_MODE: "auto", STORAGE_DIRECT_ENDPOINT: endpoint })).toThrow(
      /^Invalid STORAGE_DIRECT_ENDPOINT/,
    );
  });

  it.each(["lan", "s3", "DIRECT", "true"])("rejects TRANSFER_MODE=%s", (mode) => {
    expect(() => loadTransferConfig({ TRANSFER_MODE: mode, STORAGE_DIRECT_ENDPOINT: "https://s3.lan" })).toThrow(
      /^Invalid TRANSFER_MODE/,
    );
  });

  it.each(["https://share.example.com/path", "ftp://share.example.com", "share.example.com", "*"])(
    "rejects an invalid APP_ORIGIN=%s",
    (origin) => {
      expect(() => loadTransferConfig({ APP_ORIGIN: origin })).toThrow(/^Invalid APP_ORIGIN/);
    },
  );

  it("stops the app at startup when direct mode has no HTTPS endpoint", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "fireshare",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        TRANSFER_MODE: "direct",
        STORAGE_DIRECT_ENDPOINT: "http://storage.lan.example.com",
      }),
    ).toThrow(/^Invalid STORAGE_DIRECT_ENDPOINT/);
  });

  describe("storage key from files", () => {
    const base = { DATABASE_URL: "postgres://x", S3_ENDPOINT: "http://x", S3_BUCKET: "fireshare" };
    const files = () => {
      const dir = mkdtempSync(path.join(tmpdir(), "fireshare-config-"));
      writeFileSync(path.join(dir, "id"), "GKabc\n");
      writeFileSync(path.join(dir, "secret"), "s3cret\n");
      return { S3_ACCESS_KEY_ID_FILE: path.join(dir, "id"), S3_SECRET_ACCESS_KEY_FILE: path.join(dir, "secret") };
    };

    it("reads S3_ACCESS_KEY_ID_FILE and S3_SECRET_ACCESS_KEY_FILE, trimmed", () => {
      expect(loadConfig({ ...base, ...files() }).s3).toMatchObject({ accessKeyId: "GKabc", secretAccessKey: "s3cret" });
    });

    it("prefers the variable over its file", () => {
      expect(loadConfig({ ...base, ...files(), S3_ACCESS_KEY_ID: "k" }).s3.accessKeyId).toBe("k");
    });

    it("names a file it can't read", () => {
      expect(() =>
        loadConfig({ ...base, S3_ACCESS_KEY_ID_FILE: "/no/such/file", S3_SECRET_ACCESS_KEY: "s" }),
      ).toThrow(/^Can't read S3_ACCESS_KEY_ID_FILE "\/no\/such\/file"/);
    });
  });

  it("stops the app at startup when auto mode has no DIRECT_NETWORKS", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "fireshare",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        TRANSFER_MODE: "auto",
        STORAGE_DIRECT_ENDPOINT: "https://storage.lan.example.com",
      }),
    ).toThrow(/^Missing DIRECT_NETWORKS/);
  });
});

describe("expiry config", () => {
  it("defaults to 1d,3d,7d,14d,30d with 7d preselected", () => {
    expect(loadExpiryConfig({})).toEqual({
      options: [
        { value: "1d", seconds: 86400 },
        { value: "3d", seconds: 3 * 86400 },
        { value: "7d", seconds: 7 * 86400 },
        { value: "14d", seconds: 14 * 86400 },
        { value: "30d", seconds: 30 * 86400 },
      ],
      default: "7d",
    });
  });

  it("reads hour and day presets in the order listed", () => {
    expect(loadExpiryConfig({ EXPIRY_OPTIONS: "2d, 12h,1h", EXPIRY_DEFAULT: "12h" })).toEqual({
      options: [
        { value: "2d", seconds: 2 * 86400 },
        { value: "12h", seconds: 12 * 3600 },
        { value: "1h", seconds: 3600 },
      ],
      default: "12h",
    });
  });

  it.each(["7", "0d", "1w", "1.5d", "-1d", "1d,,3d", "07d", "10000d", "1D"])(
    "rejects EXPIRY_OPTIONS=%s",
    (value) => {
      expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: value, EXPIRY_DEFAULT: "1d" })).toThrow(
        /^Invalid EXPIRY_OPTIONS/,
      );
    },
  );

  it("rejects presets that repeat the same duration", () => {
    expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: "1d,24h", EXPIRY_DEFAULT: "1d" })).toThrow(
      /^Invalid EXPIRY_OPTIONS: "24h" repeats/,
    );
  });

  it("rejects an EXPIRY_DEFAULT that isn't one of the presets", () => {
    expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: "1d,3d", EXPIRY_DEFAULT: "7d" })).toThrow(
      'Invalid EXPIRY_DEFAULT "7d": must be one of EXPIRY_OPTIONS (1d, 3d)',
    );
    // The default for EXPIRY_DEFAULT has to be listed too.
    expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: "1d,3d" })).toThrow(/^Invalid EXPIRY_DEFAULT/);
  });

  it("is part of the app config", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "fireshare",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        EXPIRY_DEFAULT: "2d",
      }),
    ).toThrow(/^Invalid EXPIRY_DEFAULT/);
  });
});

describe("upload config", () => {
  it("defaults to 64 MB chunks and 3 files at a time", () => {
    expect(loadUploadConfig({})).toEqual({ chunkSize: 64 * 1024 * 1024, parallelFiles: 3 });
  });

  it("reads the chunk size in KB, MB or GB and the parallel file count", () => {
    expect(loadUploadConfig({ UPLOAD_CHUNK_SIZE: "8MB", UPLOAD_PARALLEL_FILES: "5" })).toEqual({
      chunkSize: 8 * 1024 * 1024,
      parallelFiles: 5,
    });
    expect(loadUploadConfig({ UPLOAD_CHUNK_SIZE: "1GB" }).chunkSize).toBe(1024 ** 3);
    expect(loadUploadConfig({ UPLOAD_CHUNK_SIZE: "5120KB" }).chunkSize).toBe(5 * 1024 * 1024);
  });

  it.each(["4MB", "6GB", "64", "64mb", "64 MB", "1.5GB", "0MB", "-64MB"])("rejects UPLOAD_CHUNK_SIZE=%s", (value) => {
    expect(() => loadUploadConfig({ UPLOAD_CHUNK_SIZE: value })).toThrow(/^Invalid UPLOAD_CHUNK_SIZE/);
  });

  it.each(["0", "11", "2.5", "-1", "three"])("rejects UPLOAD_PARALLEL_FILES=%s", (value) => {
    expect(() => loadUploadConfig({ UPLOAD_PARALLEL_FILES: value })).toThrow(/^Invalid UPLOAD_PARALLEL_FILES/);
  });
});

describe("limits config", () => {
  const off = {
    maxShareSize: null,
    maxFilesPerShare: null,
    maxTotalStorage: null,
    uploadQuotaPerIp: null,
    maxActiveSharesPerIp: null,
    rateLimitUpload: null,
    rateLimitDownload: null,
  };

  it("turns every limit off when unset or empty", () => {
    expect(loadLimitsConfig({})).toEqual(off);
    expect(
      loadLimitsConfig({
        MAX_SHARE_SIZE: "",
        MAX_FILES_PER_SHARE: " ",
        MAX_TOTAL_STORAGE: "",
        UPLOAD_QUOTA_PER_IP: "",
        MAX_ACTIVE_SHARES_PER_IP: "",
        RATE_LIMIT_UPLOAD: "",
        RATE_LIMIT_DOWNLOAD: "",
      }),
    ).toEqual(off);
  });

  it("reads sizes in KB, MB, GB or TB and whole-number counts", () => {
    expect(
      loadLimitsConfig({
        MAX_SHARE_SIZE: "50GB",
        MAX_FILES_PER_SHARE: "500",
        MAX_TOTAL_STORAGE: "2TB",
        UPLOAD_QUOTA_PER_IP: "500MB",
        MAX_ACTIVE_SHARES_PER_IP: "20",
        RATE_LIMIT_UPLOAD: "600",
        RATE_LIMIT_DOWNLOAD: "300",
      }),
    ).toEqual({
      maxShareSize: { bytes: 50 * 1024 ** 3, value: "50GB" },
      maxFilesPerShare: 500,
      maxTotalStorage: { bytes: 2 * 1024 ** 4, value: "2TB" },
      uploadQuotaPerIp: { bytes: 500 * 1024 ** 2, value: "500MB" },
      maxActiveSharesPerIp: 20,
      rateLimitUpload: 600,
      rateLimitDownload: 300,
    });
    expect(loadLimitsConfig({ UPLOAD_QUOTA_PER_IP: "64KB" }).uploadQuotaPerIp).toEqual({ bytes: 65536, value: "64KB" });
  });

  it.each(["MAX_SHARE_SIZE", "MAX_TOTAL_STORAGE", "UPLOAD_QUOTA_PER_IP"])("rejects invalid sizes in %s", (name) => {
    for (const value of ["50", "50gb", "50 GB", "1.5GB", "0GB", "-1GB", "50PB", "99999999TB"]) {
      expect(() => loadLimitsConfig({ [name]: value })).toThrow(new RegExp(`^Invalid ${name} "${value}"`));
    }
  });

  it.each(["MAX_FILES_PER_SHARE", "MAX_ACTIVE_SHARES_PER_IP", "RATE_LIMIT_UPLOAD", "RATE_LIMIT_DOWNLOAD"])(
    "rejects invalid counts in %s",
    (name) => {
      for (const value of ["0", "-1", "2.5", "ten", "1e3", "010"]) {
        expect(() => loadLimitsConfig({ [name]: value })).toThrow(new RegExp(`^Invalid ${name} "${value}"`));
      }
    },
  );

  it("stops the app at startup on an invalid limit", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "fireshare",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        MAX_SHARE_SIZE: "lots",
      }),
    ).toThrow(/^Invalid MAX_SHARE_SIZE/);
  });
});

describe("cleanup config", () => {
  it("defaults to a 1h delete grace and a 24h pending TTL", () => {
    expect(loadCleanupConfig({})).toEqual({ deleteGraceSeconds: 3600, pendingTtlSeconds: 86400 });
  });

  it("reads minutes, hours and days, including no grace at all", () => {
    expect(loadCleanupConfig({ DELETE_GRACE: "0m", PENDING_TTL: "2d" })).toEqual({
      deleteGraceSeconds: 0,
      pendingTtlSeconds: 2 * 86400,
    });
    expect(loadCleanupConfig({ DELETE_GRACE: "90m" }).deleteGraceSeconds).toBe(90 * 60);
  });

  it.each(["1", "1w", "1.5h", "-1h", "01h", "1H", "100000d"])("rejects DELETE_GRACE=%s", (value) => {
    expect(() => loadCleanupConfig({ DELETE_GRACE: value })).toThrow(/^Invalid DELETE_GRACE/);
  });

  it("rejects an invalid PENDING_TTL", () => {
    expect(() => loadCleanupConfig({ PENDING_TTL: "1 day" })).toThrow(/^Invalid PENDING_TTL "1 day"/);
  });
});

describe("access config", () => {
  it("requires an upload password unless public uploads are turned on", () => {
    expect(() => loadAccessConfig({})).toThrow(
      "Missing UPLOAD_PASSWORD: set an upload password, or set ALLOW_PUBLIC_UPLOAD=true to let anyone upload",
    );
    expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "false" })).toThrow(/^Missing UPLOAD_PASSWORD/);
    expect(loadAccessConfig({ UPLOAD_PASSWORD: "secret" })).toEqual({
      password: "secret",
      allowedIps: null,
      trustedProxies: null,
      abuseReportUrl: null,
    });
  });

  it.each(["yes", "1", "TRUE"])("rejects ALLOW_PUBLIC_UPLOAD=%s", (value) => {
    expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: value, UPLOAD_PASSWORD: "x" })).toThrow(
      /^Invalid ALLOW_PUBLIC_UPLOAD/,
    );
  });

  it("refuses a password that public uploads would ignore", () => {
    expect(() =>
      loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", UPLOAD_PASSWORD: "x", ABUSE_CONTACT: "a@example.com" }),
    ).toThrow(/set only one of them/);
  });

  it("needs an abuse contact for public uploads, as an email address or URL", () => {
    expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true" })).toThrow(/^Missing ABUSE_CONTACT/);
    expect(loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" })).toMatchObject({
      password: null,
      abuseReportUrl: "mailto:abuse@example.com?subject=Abuse%20report",
    });
    expect(
      loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "https://example.com/report" }).abuseReportUrl,
    ).toBe("https://example.com/report");
    for (const contact of ["javascript:alert(1)", "not a contact", "ftp://example.com"]) {
      expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: contact }), contact).toThrow(
        /^Invalid ABUSE_CONTACT/,
      );
    }
  });

  it("reads the allowed networks and trusted proxies", () => {
    const config = loadAccessConfig({
      UPLOAD_PASSWORD: "x",
      UPLOAD_ALLOWED_IPS: "192.168.0.0/16",
      TRUSTED_PROXIES: "172.16.0.1",
    });
    expect(config.allowedIps!.has("192.168.4.4")).toBe(true);
    expect(config.trustedProxies!.has("172.16.0.1")).toBe(true);
    expect(() => loadAccessConfig({ UPLOAD_PASSWORD: "x", UPLOAD_ALLOWED_IPS: "office" })).toThrow(
      /^Invalid UPLOAD_ALLOWED_IPS entry "office"/,
    );
  });

  it("isn't needed by the shared config the cleanup worker loads", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "fireshare",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
      }),
    ).not.toThrow();
  });
});


describe("startup validation", () => {
  const valid = {
    DATABASE_URL: "postgres://fireshare:secret@db:5432/fireshare",
    S3_ENDPOINT: "http://storage:9000",
    S3_BUCKET: "fireshare",
    S3_ACCESS_KEY_ID: "fireshare-app",
    S3_SECRET_ACCESS_KEY: "s",
    UPLOAD_PASSWORD: "p",
  };

  it("finds nothing wrong with a valid configuration", () => {
    expect(configProblems(() => loadConfig(valid), () => loadAccessConfig(valid))).toEqual([]);
  });

  it("names every bad variable at once, not just the first", () => {
    const env = {
      ...valid,
      S3_BUCKET: "",
      UPLOAD_CHUNK_SIZE: "1MB",
      UPLOAD_PARALLEL_FILES: "0",
      MAX_SHARE_SIZE: "lots",
      RATE_LIMIT_DOWNLOAD: "-1",
      DELETE_GRACE: "soon",
      TRANSFER_MODE: "direct",
      UPLOAD_PASSWORD: "",
    };
    expect(configProblems(() => loadConfig(env), () => loadAccessConfig(env)).map((p) => p.split(/[ :]/)[1])).toEqual([
      "S3_BUCKET",
      "STORAGE_DIRECT_ENDPOINT",
      "UPLOAD_CHUNK_SIZE",
      "UPLOAD_PARALLEL_FILES",
      "MAX_SHARE_SIZE",
      "RATE_LIMIT_DOWNLOAD",
      "DELETE_GRACE",
      "UPLOAD_PASSWORD",
    ]);
  });

  it("throws the problems together as one ConfigError", () => {
    const error = (() => {
      try {
        loadConfig({ ...valid, DATABASE_URL: undefined, S3_ENDPOINT: undefined });
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      "Missing DATABASE_URL: it's required (see .env.example)",
      "Missing S3_ENDPOINT: it's required (see .env.example)",
    ]);
  });

  it("skips the checks that depend on an invalid value", () => {
    expect(configProblems(() => loadTransferConfig({ TRANSFER_MODE: "fast", DIRECT_NETWORKS: "10.0.0.0/8" }))).toEqual([
      'Invalid TRANSFER_MODE "fast": use proxy, direct or auto',
    ]);
    expect(configProblems(() => loadExpiryConfig({ EXPIRY_OPTIONS: "1w", EXPIRY_DEFAULT: "1w" }))).toHaveLength(1);
    expect(configProblems(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "yes" }))).toEqual([
      'Invalid ALLOW_PUBLIC_UPLOAD "yes": use true or false',
    ]);
  });

  it("checks the database URL without repeating its password", () => {
    for (const url of ["mysql://fireshare:hunter2@db/fireshare", "db:5432", "hunter2"]) {
      const problems = configProblems(() => loadConfig({ ...valid, DATABASE_URL: url }));
      expect(problems).toEqual([expect.stringMatching(/^Invalid DATABASE_URL: use a postgres:\/\/ URL/)]);
      expect(problems[0]).not.toContain("hunter2");
    }
    expect(configProblems(() => loadConfig({ ...valid, DATABASE_URL: "postgresql://u:p@db/x" }))).toEqual([]);
  });

  it("checks the storage endpoint and bucket name", () => {
    expect(configProblems(() => loadConfig({ ...valid, S3_ENDPOINT: "storage:9000" }))).toEqual([
      'Invalid S3_ENDPOINT "storage:9000": use an http(s) URL, like http://storage:3900',
    ]);
    for (const bucket of ["ab", "FireShare", "fire_share", "-fireshare", "x".repeat(64)]) {
      expect(configProblems(() => loadConfig({ ...valid, S3_BUCKET: bucket })), bucket).toEqual([
        expect.stringMatching(/^Invalid S3_BUCKET/),
      ]);
    }
    expect(configProblems(() => loadConfig({ ...valid, S3_BUCKET: "fire.share-01" }))).toEqual([]);
  });

  it("describes the problems one per line", () => {
    expect(describeConfigProblems("FireShare", ["Missing A: x", "Invalid B: y"])).toBe(
      "FireShare can't start. Fix these 2 settings in .env:\n  - Missing A: x\n  - Invalid B: y",
    );
    expect(describeConfigProblems("The cleanup worker", ["Missing A: x"])).toBe(
      "The cleanup worker can't start. Fix this setting in .env:\n  - Missing A: x",
    );
  });
});
