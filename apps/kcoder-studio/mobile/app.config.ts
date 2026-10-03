import type { ConfigContext, ExpoConfig } from "expo/config";
import appJson from "./app.json";

export function allowHttpGatewayForEnvironment(
  environment: Record<string, string | undefined>,
): boolean {
  if (environment.KCODER_STUDIO_ALLOW_HTTP === "1") return true;
  return false;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  // Development may connect directly to private HTTP endpoints; production permits HTTPS by default and requires explicit opt-in for HTTP.
  const allowHttpGateway = allowHttpGatewayForEnvironment(process.env);
  const plugins = appJson.expo.plugins.filter(
    (plugin) =>
      !(Array.isArray(plugin) && plugin[0] === "expo-build-properties"),
  );
  return {
    ...config,
    ...appJson.expo,
    ios: {
      ...appJson.expo.ios,
      infoPlist: allowHttpGateway
        ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }
        : {},
    },
    plugins: [
      ...plugins,
      [
        "expo-build-properties",
        { android: { usesCleartextTraffic: allowHttpGateway } },
      ],
    ],
  } as ExpoConfig;
};
