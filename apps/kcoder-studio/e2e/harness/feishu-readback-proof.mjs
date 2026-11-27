/** Compare a read-back message to the exact type and text accepted by the send receipt. */
export function matchesFeishuReadback(item, { receipt, chatId, text }) {
  if (!item || item.message_id !== receipt?.messageId || item.chat_id !== chatId
      || item.msg_type !== receipt.messageType || typeof item.body?.content !== 'string') return false;
  let body;
  try { body = JSON.parse(item.body.content); } catch { return false; }
  if (receipt.messageType === 'text') return body?.text === text;
  if (receipt.messageType !== 'post') return false;
  const rows = body?.zh_cn?.content;
  return Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) && rows[0].length === 1
    && rows[0][0]?.tag === 'md' && rows[0][0]?.text === text;
}
