import { describe, expect, it } from "vitest";
import { choosePermission, parseKeyPermissions } from "./chain";
import { assertSigningPermission, signingPermissionViolation } from "./policy";

const KEY = "PUB_K1_test_key_for_fixtures_only";
const OTHER = "PUB_K1_some_other_key";

const perm = (
  name: string,
  parent: string,
  keys: { key: string; weight: number }[],
  threshold = 1,
  linked: { account: string; action: string }[] = [],
) => ({
  perm_name: name,
  parent,
  required_auth: { threshold, keys },
  linked_actions: linked,
});

describe("parseKeyPermissions + choosePermission", () => {
  it("blocks an owner-only key", () => {
    const m = parseKeyPermissions(
      { permissions: [perm("owner", "", [{ key: KEY, weight: 1 }]), perm("active", "owner", [{ key: OTHER, weight: 1 }])] },
      [KEY],
    );
    const c = choosePermission(m);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/OWNER/);
  });

  it("blocks a key that is on BOTH owner and active", () => {
    const m = parseKeyPermissions(
      { permissions: [perm("owner", "", [{ key: KEY, weight: 1 }]), perm("active", "owner", [{ key: KEY, weight: 1 }])] },
      [KEY],
    );
    expect(m.map((x) => x.perm)).toEqual(["owner", "active"]);
    expect(choosePermission(m).ok).toBe(false);
  });

  it("uses the single custom permission and reports its linked actions", () => {
    const linked = [
      { account: "eosio.token", action: "transfer" },
      { account: "swap.alcor", action: "collect" },
    ];
    const m = parseKeyPermissions(
      {
        permissions: [
          perm("owner", "", [{ key: OTHER, weight: 1 }]),
          perm("active", "owner", [{ key: OTHER, weight: 1 }]),
          perm("trade", "active", [{ key: KEY, weight: 1 }], 1, linked),
        ],
      },
      [KEY],
    );
    const c = choosePermission(m);
    expect(c).toEqual({ ok: true, permission: "trade", linked });
  });

  it("allows an active-only key with a warning", () => {
    const m = parseKeyPermissions(
      { permissions: [perm("owner", "", [{ key: OTHER, weight: 1 }]), perm("active", "owner", [{ key: KEY, weight: 1 }])] },
      [KEY],
    );
    const c = choosePermission(m);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.permission).toBe("active");
      expect(c.warning).toMatch(/ACTIVE/);
    }
  });

  it("refuses a key on several custom permissions", () => {
    const m = parseKeyPermissions(
      {
        permissions: [
          perm("trade", "active", [{ key: KEY, weight: 1 }]),
          perm("claim", "active", [{ key: KEY, weight: 1 }]),
        ],
      },
      [KEY],
    );
    const c = choosePermission(m);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/several custom/);
  });

  it("ignores permissions the key cannot satisfy alone (multisig weight < threshold)", () => {
    const m = parseKeyPermissions(
      { permissions: [perm("active", "owner", [{ key: KEY, weight: 1 }, { key: OTHER, weight: 1 }], 2)] },
      [KEY],
    );
    expect(m).toEqual([]);
    expect(choosePermission(m).ok).toBe(false);
  });

  it("matches the legacy key form too", () => {
    const m = parseKeyPermissions(
      { permissions: [perm("trade", "active", [{ key: "EOS_legacy_form", weight: 1 }])] },
      [KEY, "EOS_legacy_form"],
    );
    expect(m.map((x) => x.perm)).toEqual(["trade"]);
  });
});

describe("signingPermissionViolation", () => {
  it("refuses missing, empty and owner permissions", () => {
    expect(signingPermissionViolation(undefined)).toMatch(/explicit permission/);
    expect(signingPermissionViolation("")).toMatch(/explicit permission/);
    expect(signingPermissionViolation("owner")).toMatch(/owner/);
    expect(signingPermissionViolation("Not Valid!")).toMatch(/not a valid permission/);
    expect(() => assertSigningPermission("owner")).toThrow(/Transaction policy/);
  });

  it("accepts active and custom permissions", () => {
    expect(signingPermissionViolation("active")).toBeNull();
    expect(signingPermissionViolation("trade")).toBeNull();
    expect(() => assertSigningPermission("trade")).not.toThrow();
  });
});
