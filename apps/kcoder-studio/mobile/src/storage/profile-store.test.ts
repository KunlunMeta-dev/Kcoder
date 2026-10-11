import { describe, expect, it } from "vitest";
import { PROFILE_INDEX_KEY, profileStoreTestHelpers } from "./profile-store";

describe("原生 profile 存储键", () => {
  it("只生成 Expo SecureStore 支持的键字符", () => {
    const allowed = /^[A-Za-z0-9._-]+$/;
    expect(PROFILE_INDEX_KEY).toMatch(allowed);
    expect(profileStoreTestHelpers.profileSecretKey("host:https://127.0.0.1:4173/用户")).toMatch(allowed);
  });

  it("为不同 profile 生成不同的凭据键", () => {
    expect(profileStoreTestHelpers.profileSecretKey("gateway-a")).not.toBe(
      profileStoreTestHelpers.profileSecretKey("gateway-b"),
    );
  });
});
