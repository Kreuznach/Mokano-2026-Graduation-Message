import test from 'node:test';
import assert from 'node:assert/strict';
import { LETTER_RULES, validateLetter, countLines, normalizeNewlines, scanText } from '../public/assets/letter-rules.js';

const lines = (n, text = '줄') => Array.from({ length: n }, () => text).join('\n');

test('이름: 비우거나 공백뿐이면 null(익명), 앞뒤 공백 제거', () => {
  assert.equal(validateLetter({ senderName: '', content: 'a' }).value.senderName, null);
  assert.equal(validateLetter({ senderName: '   \u3000 ', content: 'a' }).value.senderName, null);
  assert.equal(validateLetter({ content: 'a' }).value.senderName, null);
  assert.equal(validateLetter({ senderName: '  모카팬 ', content: 'a' }).value.senderName, '모카팬');
});

test('이름: 40자(코드 포인트) 경계, 이모지는 1자로 계산', () => {
  assert.equal(validateLetter({ senderName: '가'.repeat(40), content: 'a' }).ok, true);
  assert.equal(validateLetter({ senderName: '가'.repeat(41), content: 'a' }).errors.senderName, 'name_too_long');
  assert.equal(validateLetter({ senderName: '🥹'.repeat(40), content: 'a' }).ok, true);
  assert.equal(validateLetter({ senderName: '🥹'.repeat(41), content: 'a' }).errors.senderName, 'name_too_long');
});

test('이름: 제어 문자·잘못된 타입은 거절', () => {
  assert.equal(validateLetter({ senderName: '모\n카', content: 'a' }).errors.senderName, 'name_invalid');
  assert.equal(validateLetter({ senderName: 123, content: 'a' }).errors.senderName, 'name_invalid');
});

test('내용: 공백·개행뿐이면 거절', () => {
  for (const content of ['', '   ', '\n\n\n', '\t \r\n \u3000', undefined, null, 42]) {
    assert.equal(validateLetter({ content }).errors.content, 'content_required', JSON.stringify(content));
  }
});

test('내용: CRLF/CR 을 LF 로 정규화하고 한글·일본어·이모지·개행을 보존', () => {
  const r = validateLetter({ content: '모카야\r\nありがとう\r🥹💜\n\n끝' });
  assert.equal(r.ok, true);
  assert.equal(r.value.content, '모카야\nありがとう\n🥹💜\n\n끝');
  assert.equal(r.stats.lines, 5);
  assert.equal(normalizeNewlines('a\r\n\r\nb'), 'a\n\nb');
});

test('내용: 2,000줄 통과 / 2,001줄 거절 (CRLF 도 같은 기준)', () => {
  assert.equal(LETTER_RULES.contentMaxLines, 2000);
  assert.equal(validateLetter({ content: lines(2000) }).ok, true);
  assert.equal(validateLetter({ content: lines(2001) }).errors.content, 'content_too_many_lines');
  assert.equal(validateLetter({ content: lines(2000).replace(/\n/g, '\r\n') }).ok, true);
  assert.equal(validateLetter({ content: `${lines(2000)}\n` }).errors.content, 'content_too_many_lines');
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 2);
});

test('내용: 2,000자가 아니라 줄 수 기준 (긴 한 줄은 바이트 상한까지 허용)', () => {
  assert.equal(validateLetter({ content: '가'.repeat(5000) }).ok, true);
});

test('내용: UTF-8 256KiB 경계', () => {
  const max = LETTER_RULES.contentMaxBytes;
  assert.equal(max, 262144);
  assert.equal(validateLetter({ content: 'a'.repeat(max) }).ok, true);
  assert.equal(validateLetter({ content: 'a'.repeat(max + 1) }).errors.content, 'content_too_large');
  // 한글 3바이트, 이모지 4바이트
  assert.equal(scanText('가').bytes, 3);
  assert.equal(scanText('🥹').bytes, 4);
  assert.equal(scanText('é').bytes, 2);
  assert.equal(validateLetter({ content: '🥹'.repeat(max / 4) }).ok, true);
  assert.equal(validateLetter({ content: `${'🥹'.repeat(max / 4)}a` }).errors.content, 'content_too_large');
  assert.equal(scanText('가🥹a').bytes, new TextEncoder().encode('가🥹a').length);
});

test('내용: 짝 없는 서로게이트·NUL 은 거절, HTML 은 그대로 보존(실행하지 않음)', () => {
  assert.equal(validateLetter({ content: 'a\uD83Db' }).errors.content, 'content_invalid');
  assert.equal(validateLetter({ content: 'a\u0000b' }).errors.content, 'content_invalid');
  const xss = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  assert.equal(validateLetter({ content: xss }).value.content, xss);
});
