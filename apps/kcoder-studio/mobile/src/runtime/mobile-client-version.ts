import Constants from "expo-constants";
import appJson from "../../app.json";

export type MobileClientVersionSource = "nativeAppVersion" | "app.json" | "unavailable";

export interface MobileClientVersion {
  value: string | null;
  source: MobileClientVersionSource;
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

export function resolveMobileClientVersion(
  nativeAppVersion: unknown,
  bundledVersion: unknown,
): MobileClientVersion {
  if (validVersion(nativeAppVersion))
    return { value: nativeAppVersion, source: "nativeAppVersion" };
  if (validVersion(bundledVersion))
    return { value: bundledVersion, source: "app.json" };
  return { value: null, source: "unavailable" };
}

export function getMobileClientVersion(): MobileClientVersion {
  // Read the release file directly so a cached Expo virtual manifest cannot supply an older version.
  return resolveMobileClientVersion(
    Constants.nativeAppVersion,
    appJson.expo.version,
  );
}
