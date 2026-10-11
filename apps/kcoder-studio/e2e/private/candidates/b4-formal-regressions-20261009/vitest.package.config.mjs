// Existing Mobile package configuration, with only an owned cache override.
// No overlay/source/dependency aliases: formal tests resolve from Mobile/src.
import base from "../../../../mobile/vitest.config.ts";
import { isAbsolute } from "node:path";
const cacheDir = process.env.KCODER_PRIVATE_VITEST_CACHE;
if (!cacheDir || !isAbsolute(cacheDir)) throw new Error("owned absolute Vitest cache required");
export default { ...base, cacheDir };
