import { requireValue } from './errors.mjs';
import { boundedText, canonical, identifier } from './validation.mjs';

const invalid = value => requireValue(value, 'PLATFORM_INVALID_JSON');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_PARTS = 4096;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function text(value) { invalid(typeof value === 'string'); return boundedText(value); }

export function parsedContent(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    boundedText(raw, 256 * 1024);
    try { value = JSON.parse(raw); }
    catch { return { text: raw }; }
  }
  invalid(record(value));
  if (typeof raw !== 'string') boundedText(canonical(value), 256 * 1024);
  return value;
}

export function feishuMentions(value) {
  if (value === undefined) return [];
  invalid(Array.isArray(value));
  requireValue(value.length <= MAX_PARTS, 'PAYLOAD_TOO_LARGE');
  for (const item of value) invalid(record(item) && typeof item.key === 'string' && record(item.id));
  return value;
}

export function feishuContent(body, message, botOpenId, mentions) {
  const keys = [...new Set(mentions.filter(item => botOpenId && item.id.open_id === botOpenId).map(item => identifier(item.key, 'mention')))];
  // Match a complete SDK placeholder, never another user's longer key.
  const addressed = keys.length ? new RegExp('(^|[^A-Za-z0-9_])(?:' + keys.sort((a, b) => b.length - a.length).map(escape).join('|') + ')(?![A-Za-z0-9_])', 'g') : null;
  const strip = value => addressed ? value.replace(addressed, '$1') : value;
  if (message.message_type !== 'post') {
    const original = text(body.text === undefined ? '' : body.text), content = strip(original);
    return { text: content !== original ? content.trim() : content, attachments: [] };
  }

  let post = body;
  if (!Object.hasOwn(body, 'title') && !Object.hasOwn(body, 'content')) {
    post = undefined;
    for (const locale of [...new Set(['zh_cn', 'en_us', 'ja_jp', ...Object.keys(body)])]) {
      if (Object.hasOwn(body, locale) && record(body[locale])) { post = body[locale]; break; }
    }
  }
  invalid(record(post) && (Object.hasOwn(post, 'title') || Object.hasOwn(post, 'content')));
  const paragraphs = post.content === undefined ? [] : post.content;
  invalid(Array.isArray(paragraphs));
  requireValue(paragraphs.length <= MAX_PARTS, 'PAYLOAD_TOO_LARGE');
  const lines = [], attachments = [];
  if (post.title !== undefined) lines.push(strip(text(post.title)));
  let parts = 0;
  const media = (kind, key) => {
    identifier(key, 'media'); identifier(message.message_id, 'source_message');
    requireValue(attachments.length < 32, 'TOO_MANY_ATTACHMENTS');
    attachments.push({ kind, mediaId: key, sourceMessageId: message.message_id, filename: 'attachment' });
  };
  for (const paragraph of paragraphs) {
    invalid(Array.isArray(paragraph));
    requireValue((parts += paragraph.length) <= MAX_PARTS, 'PAYLOAD_TOO_LARGE');
    const content = [];
    for (const item of paragraph) {
      invalid(record(item) && typeof item.tag === 'string');
      switch (item.tag) {
        case 'text': case 'md': content.push(strip(text(item.text))); break;
        case 'code_block': content.push(text(item.text)); break;
        case 'a': content.push(strip(text(item.text ?? item.href))); break;
        case 'at': {
          const id = identifier(item.user_id, 'mention');
          const known = mentions.find(mention => mention.id.open_id === id || mention.id.user_id === id || mention.id.union_id === id);
          if (botOpenId && (id === botOpenId || known?.id.open_id === botOpenId)) break;
          content.push('@' + text(item.user_name ?? known?.name ?? id)); break;
        }
        case 'img': media('image', item.image_key); break;
        case 'media': media('file', item.file_key); break;
        case 'emotion': content.push(':' + text(item.emoji_type) + ':'); break;
        case 'hr': content.push('\n---\n'); break;
        default: requireValue(false, 'PLATFORM_MESSAGE_UNSUPPORTED');
      }
    }
    lines.push(content.join(''));
  }
  let first = 0, last = lines.length;
  while (first < last && lines[first] === '') first++;
  while (last > first && lines[last - 1] === '') last--;
  return { text: boundedText(lines.slice(first, last).join('\n')), attachments };
}

export function dingtalkContent(message) {
  let kind = message.msgtype;
  if (kind === undefined && (message.text !== undefined || typeof message.content === 'string')) kind = 'text';
  invalid(typeof kind === 'string' && kind.length > 0);
  if (kind === 'text') {
    let value = message.content;
    if (message.text !== undefined) value = record(message.text) ? message.text.content : message.text;
    return { text: text(value), attachments: [] };
  }
  const body = message.content;
  invalid(record(body) || typeof body === 'string');
  const attachments = [];
  const media = (item, type) => {
    const code = item.downloadCode ?? item.pictureDownloadCode;
    invalid(typeof code === 'string' && code.length > 0);
    boundedText(code, 16 * 1024);
    requireValue(attachments.length < 32, 'TOO_MANY_ATTACHMENTS');
    const filename = item.fileName ?? 'attachment'; text(filename);
    attachments.push({ kind: type === 'picture' ? 'image' : 'file', mediaId: code, filename });
  };
  if (kind === 'richText') {
    invalid(record(body) && Array.isArray(body.richText));
    requireValue(body.richText.length <= MAX_PARTS, 'PAYLOAD_TOO_LARGE');
    const parts = [];
    for (const item of body.richText) {
      invalid(record(item));
      let recognized = false;
      if (item.text !== undefined) { parts.push(text(item.text)); recognized = true; }
      if (item.downloadCode !== undefined || item.pictureDownloadCode !== undefined) { media(item, item.type); recognized = true; }
      invalid(recognized);
    }
    return { text: boundedText(parts.join('')), attachments };
  }
  if (['picture', 'file', 'video', 'audio', 'voice'].includes(kind)) {
    invalid(record(body)); media(body, kind); return { text: '', attachments };
  }
  // A declared unsupported kind is not a malformed recognized payload. It owns
  // no task or private reply context; the caller still validates its identity.
  return null;
}
