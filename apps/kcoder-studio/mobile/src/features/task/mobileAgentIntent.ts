import { t } from "@/i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";

/** UI lookup handles only; accepted commands remain authoritative on the target. */
export interface MobileAgentIntent {
  clientMessageId: string;
  createdAt: number;
}
const prefix = "kcoder.mobile.agent-intent.v1:";
export function agentIntentKey(scope: string): string {
  return prefix + encodeURIComponent(scope);
}
export async function readAgentIntent(
  scope: string,
): Promise<MobileAgentIntent | null> {
  const raw = await AsyncStorage.getItem(agentIntentKey(scope));
  if (!raw) return null;
  if (raw.length > 1024)
    throw new Error(t("task.the_agent_query_record_is_too_large"));
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error(t("task.the_agent_query_record_is_invalid"));
  const row = value as Partial<MobileAgentIntent>;
  if (
    typeof row.clientMessageId !== "string" ||
    !/^cmd:\d+:[a-zA-Z0-9-]{1,128}$/.test(row.clientMessageId) ||
    !Number.isSafeInteger(row.createdAt)
  )
    throw new Error(t("task.the_agent_query_record_is_invalid"));
  return { clientMessageId: row.clientMessageId, createdAt: row.createdAt! };
}
let mutation = Promise.resolve();
function serialize(write: () => Promise<void>): Promise<void> {
  const current = mutation.then(write);
  mutation = current.catch(() => {});
  return current;
}
export function saveAgentIntent(
  scope: string,
  intent: MobileAgentIntent,
): Promise<void> {
  return serialize(async () => {
    const key = agentIntentKey(scope);
    if (key.length > 2048)
      throw new Error(t("task.the_agent_query_scope_is_too_large"));
    const existing = await readAgentIntent(scope);
    if (existing && existing.clientMessageId !== intent.clientMessageId)
      throw new Error(
        t("task.the_original_instruction_result_is_unknown_its_query"),
      );
    const keys = (await AsyncStorage.getAllKeys()).filter((value) =>
      value.startsWith(prefix),
    );
    if (!keys.includes(key) && keys.length >= 128)
      throw new Error(
        t("task.agent_query_records_are_full_check_the_original"),
      );
    const rows = await AsyncStorage.multiGet(keys);
    const value = JSON.stringify({
      clientMessageId: intent.clientMessageId,
      createdAt: intent.createdAt,
    });
    const size =
      new TextEncoder().encode(key + value).byteLength +
      rows.reduce(
        (total, [other, body]) =>
          other === key
            ? total
            : total + new TextEncoder().encode(other + (body ?? "")).byteLength,
        0,
      );
    if (size > 64 * 1024)
      throw new Error(t("task.agent_query_records_exceed_the_capacity_limit"));
    await AsyncStorage.setItem(key, value);
  });
}
export function clearAgentIntent(scope: string): Promise<void> {
  return serialize(() => AsyncStorage.removeItem(agentIntentKey(scope)));
}
