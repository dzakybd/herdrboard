import { describe, expect, test } from "bun:test";
import { Store } from "../src/db.ts";
import { profilesFromZshrc, storeRole } from "../src/profiles.ts";

const profiles = [{ name: "cc2", command: "cc2" }];

describe("storeRole", () => {
  test("accepts a name or a config, drops empty fields", () => {
    expect(storeRole("cc2", profiles)).toBe('{"profile":"cc2"}');
    expect(storeRole({ profile: "", model: "claude-opus-5-5[1m]", effort: "max", mode: "plan" }, profiles)).toBe(
      '{"model":"claude-opus-5-5[1m]","effort":"max","mode":"plan"}',
    );
    expect(storeRole({ model: " " }, profiles)).toBeNull();
    expect(storeRole("", profiles)).toBeNull();
  });
  test("rejects unknown values and shell injection in the model", () => {
    expect(() => storeRole("cc9", profiles)).toThrow("unknown profile");
    expect(() => storeRole({ model: "opus; rm -rf ~" }, profiles)).toThrow("invalid model");
    expect(() => storeRole({ effort: "huge" }, profiles)).toThrow("effort");
    expect(() => storeRole({ mode: "yolo" }, profiles)).toThrow("mode");
  });
});

describe("profiles", () => {
  test("finds cc launchers, skips resume variants", () => {
    expect(profilesFromZshrc("cc1() {\ncc1r() {\nccd() {\n_cc_account() {").map((p) => p.name)).toEqual(["cc1", "ccd"]);
  });
  test("settings stored before role configs are migrated", () => {
    const store = new Store(":memory:", () => ({ profiles, roles: { orchestrator: "cc2", worker: "cc2", reviewer: "cc2" } as any, maxWorkers: 1, maxRounds: 1 }));
    expect(store.settings().roles.worker).toEqual({ profile: "cc2", mode: "bypassPermissions" });
  });
});
