/** SOURCE ONLY / UNRUN. DATA boundary tests do not fake successful native upload. */
import { describe, expect, test } from "bun:test";
import {
  assertMoneyNormalWorkerSigningGenesisContributionCurrent,
  moneyNormalVersionUploadArguments,
  parseMoneyNormalVersionUploadRequest,
  readMoneyNormalWorkerSigningGenesisContribution,
  uploadMoneyNormalWorkerReplacementVersionForOriginalContext,
  uploadMoneyNormalWorkerVersion,
  uploadMoneyNormalWorkerVersionForOriginalContext,
} from "../scripts/deploy/money-normal-worker-version-upload.ts";

const fields = {
  targetPath: "/private/target.json",
  originalCreateInputPath: "/private/create.json",
  convertDeclarationPath: "/private/convert.json",
  convertedBackupPath: "/private/converted94.sql",
  normalSourceRoot: "/private/reviewed-normal-source",
  previousWriterEpoch: `sha256:${"1".repeat(64)}`,
  nextWriterEpoch: `sha256:${"2".repeat(64)}`,
};
describe("inactive original money Version upload boundary", () => {
  test("the closed request is only DATA and cannot supply source commit or execution authority", async () => {
    const captured = parseMoneyNormalVersionUploadRequest(fields);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.keys(captured).sort()).toEqual(Object.keys(fields).sort());
    for (const key of [
      "run",
      "state",
      "configPath",
      "writeConfig",
      "assertUploadedVersion",
      "ready",
      "sourceCommit",
      "lease",
      "outputRoot",
    ]) {
      await expect(uploadMoneyNormalWorkerVersion({ ...fields, [key]: true })).rejects.toThrow(
        "accepts only",
      );
    }
  });
  test("replacement is a distinct live-owner path, never an original request flag or JSON witness", async () => {
    await expect(
      uploadMoneyNormalWorkerVersion({ ...fields, replacementAfterUnknown: true }),
    ).rejects.toThrow("accepts only");
    await expect(
      uploadMoneyNormalWorkerReplacementVersionForOriginalContext(
        { kind: "takoserver.money-held-convert-context@v1", facts: {} } as never,
        fields,
      ),
    ).rejects.toThrow("money held convert context or source request differs");
  });
  test("accessors proxies relative paths equal epochs and missing fields refuse before any native factory", () => {
    let reads = 0;
    const accessor = { ...fields };
    Object.defineProperty(accessor, "targetPath", {
      get() {
        reads++;
        throw new Error("fixture accessor must not run");
      },
    });
    expect(() => parseMoneyNormalVersionUploadRequest(accessor)).toThrow("own string DATA");
    const proxy = new Proxy(fields, {
      getPrototypeOf() {
        reads++;
        throw new Error("fixture proxy must not run");
      },
    });
    expect(() => parseMoneyNormalVersionUploadRequest(proxy)).toThrow("plain closed");
    expect(reads).toBe(0);
    expect(() =>
      parseMoneyNormalVersionUploadRequest({ ...fields, targetPath: "relative.json" }),
    ).toThrow("canonical");
    expect(() =>
      parseMoneyNormalVersionUploadRequest({
        ...fields,
        nextWriterEpoch: fields.previousWriterEpoch,
      }),
    ).toThrow("distinct");
    const { convertedBackupPath: _missing, ...partial } = fields;
    expect(() => parseMoneyNormalVersionUploadRequest(partial)).toThrow("accepts only");
  });
  test("the existing staged upload recipe cannot request deploy traffic routes or triggers", () => {
    const argv = moneyNormalVersionUploadArguments({
      bundlePath: "/owned/sealed/worker.js",
      configPath: "/owned/sealed/wrangler.jsonc",
      workerName: "fixture-original-host",
      message: "takoserver-worker:fixture",
      secretsFilePath: "/owned/sealed-private/secrets.json",
    });
    expect(argv.slice(0, 2)).toEqual(["versions", "upload"]);
    expect(argv.filter((value) => value === "upload")).toHaveLength(1);
    expect(argv).toContain("--no-bundle");
    expect(argv).toContain("--strict");
    expect(
      argv.some(
        (value) =>
          value === "deploy" ||
          value.includes("@100%") ||
          value === "triggers" ||
          value === "--routes",
      ),
    ).toBe(false);
    expect(argv.filter((value) => value === "--secrets-file")).toHaveLength(1);
    expect(argv[argv.indexOf("--secrets-file") + 1]).toBe("/owned/sealed-private/secrets.json");
    expect(Object.isFrozen(argv)).toBe(true);
  });
  test("JSON mode facts and cloned contribution cannot authorize fresh signing genesis", async () => {
    const fake = JSON.parse("{}");
    await expect(
      readMoneyNormalWorkerSigningGenesisContribution(
        fake,
        fake,
        "/owned/normal-worker.selector.json",
      ),
    ).rejects.toThrow();
    await expect(
      assertMoneyNormalWorkerSigningGenesisContributionCurrent(fake, fake, fake),
    ).rejects.toThrow("original retained owner");
  });
  test("lost or JSON-cloned upload receipts and proxy data never recreate a live genesis witness", async () => {
    const fake = JSON.parse("{}");
    let reads = 0;
    const receipt = {
      get selectorPath() {
        reads++;
        throw new Error("must not inspect forged receipt");
      },
    };
    await expect(
      readMoneyNormalWorkerSigningGenesisContribution(fake, fake, receipt),
    ).rejects.toThrow("original live upload witness");
    const proxy = new Proxy(receipt, {
      get() {
        reads++;
        throw new Error("must not inspect proxy");
      },
    });
    await expect(
      readMoneyNormalWorkerSigningGenesisContribution(fake, fake, proxy),
    ).rejects.toThrow("original live upload witness");
    await expect(
      readMoneyNormalWorkerSigningGenesisContribution(
        fake,
        fake,
        JSON.parse(JSON.stringify({ qualification: "immutable-version-only" })),
      ),
    ).rejects.toThrow("original live upload witness");
    await expect(uploadMoneyNormalWorkerVersionForOriginalContext(fake, fields)).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
