// 브라우저(letters.js)와 서버(server/letters-api.js)가 같은 규칙을 쓰도록 한 파일에 모아 둡니다.
export const LETTER_RULES = Object.freeze({
  nameMaxChars: 40,
  contentMaxLines: 2000,
  contentMaxBytes: 256 * 1024,
  cooldownHours: 48,
});

const NAME_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

// 실제 개행(\n) 기준. 화면 폭에 따른 자동 줄바꿈은 세지 않습니다.
export function countLines(text) {
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  return lines;
}

// UTF-8 바이트 수와 짝 없는 서로게이트 여부를 한 번에 계산 (큰 입력에서도 메모리 할당 없음)
export function scanText(text) {
  let bytes = 0;
  let loneSurrogate = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
        loneSurrogate = true;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bytes += 3;
      loneSurrogate = true;
    } else bytes += 3;
  }
  return { bytes, loneSurrogate };
}

export function countChars(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * @param {{ senderName?: unknown, content?: unknown }} input
 * @returns {{ ok: boolean, value: { senderName: string | null, content: string },
 *   errors: { senderName?: string, content?: string }, stats: { nameChars: number, lines: number, bytes: number } }}
 */
export function validateLetter(input) {
  const errors = {};
  const rawName = input ? input.senderName : undefined;
  const rawContent = input ? input.content : undefined;

  let senderName = null;
  let nameChars = 0;
  if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
    errors.senderName = 'name_invalid';
  } else {
    const trimmed = (rawName || '').trim();
    nameChars = countChars(trimmed);
    if (nameChars > LETTER_RULES.nameMaxChars) errors.senderName = 'name_too_long';
    else if (NAME_FORBIDDEN.test(trimmed) || scanText(trimmed).loneSurrogate) errors.senderName = 'name_invalid';
    senderName = trimmed === '' ? null : trimmed;
  }

  const content = typeof rawContent === 'string' ? normalizeNewlines(rawContent) : '';
  const lines = countLines(content);
  const { bytes, loneSurrogate } = scanText(content);
  if (typeof rawContent !== 'string' || content.trim() === '') errors.content = 'content_required';
  else if (loneSurrogate || content.includes('\u0000')) errors.content = 'content_invalid';
  else if (lines > LETTER_RULES.contentMaxLines) errors.content = 'content_too_many_lines';
  else if (bytes > LETTER_RULES.contentMaxBytes) errors.content = 'content_too_large';

  return {
    ok: !errors.senderName && !errors.content,
    value: { senderName, content },
    errors,
    stats: { nameChars, lines, bytes },
  };
}
