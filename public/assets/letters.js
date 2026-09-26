import { LETTER_RULES, validateLetter } from './letter-rules.js';
import { createEmojiLayer } from './emoji-layer.js';

const API = { status: '/api/letters/status', submit: '/api/letters' };
// 서버가 알려 준 "다음 작성 가능 시각"만 캐시 (화면 복원용. 제한의 최종 판단은 서버)
const STORAGE_KEYS = { nextAllowedAt: 'mokano:letters:nextAllowedAt', motion: 'mokano:letters:motion' };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATUS_RECHECK_GAP_MS = 4000;
const RETRY_DELAY_MS = 1200;

const LABELS = {
  submit: '편지 보내기',
  submitting: '편지 보내는 중…',
  checking: '확인하는 중…',
  motionOff: '움직임 끄기',
  motionOn: '움직임 켜기',
};

const numberFormat = new Intl.NumberFormat('ko-KR');
const fmt = (n) => numberFormat.format(n);
const kb = (bytes) => (Math.ceil((bytes / 1024) * 10) / 10).toFixed(bytes >= 10 * 1024 ? 0 : 1);

const FIELD_MESSAGES = {
  name_too_long: (s) => `이름은 ${LETTER_RULES.nameMaxChars}자까지 쓸 수 있어요. (지금 ${fmt(s.nameChars)}자)`,
  name_invalid: () => '이름에 쓸 수 없는 문자가 들어 있어요.',
  content_required: () => '편지 내용을 적어 주세요. 공백만으로는 보낼 수 없어요.',
  content_invalid: () => '편지에 저장할 수 없는 문자가 들어 있어요. 복사해 온 글이라면 깨진 글자를 지우고 다시 시도해 주세요.',
  content_too_many_lines: (s) => `편지는 ${fmt(LETTER_RULES.contentMaxLines)}줄까지 보낼 수 있어요. (지금 ${fmt(s.lines)}줄)`,
  content_too_large: (s) => `편지가 너무 길어요. 전체 256KB까지 보낼 수 있어요. (지금 약 ${kb(s.bytes)}KB)`,
};

const KEEP = '쓴 내용은 그대로 남아 있어요.';
const SERVER_MESSAGES = {
  network: `인터넷 연결이 불안정해서 편지를 보내지 못했어요. ${KEEP} 잠시 후 다시 눌러 주세요.`,
  storage_unavailable: `편지함이 잠시 응답하지 않아요. ${KEEP} 잠시 후 다시 눌러 주세요.`,
  server_misconfigured: `지금은 편지를 받을 준비가 되지 않았어요. ${KEEP} 내용을 따로 복사해 두고 나중에 다시 시도해 주세요.`,
  browser_cookie_required: `이 브라우저가 확인용 쿠키를 저장하지 않아 편지를 보낼 수 없어요. ${KEEP} 쿠키(사이트 데이터) 저장을 허용한 뒤 다시 눌러 주세요.`,
  forbidden_origin: `이 주소에서는 편지를 보낼 수 없어요. ${KEEP} 공식 페이지 주소에서 다시 시도해 주세요.`,
  payload_too_large: `편지가 너무 길어요. 전체 256KB까지 보낼 수 있어요. ${KEEP}`,
  default: `편지를 보내지 못했어요. ${KEEP} 잠시 후 다시 눌러 주세요.`,
};

/* ---------- 저장소 (막혀 있어도 페이지는 동작) ---------- */
const storage = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* 무시 */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch { /* 무시 */ }
  },
};

const state = {
  view: 'checking', // checking | form | limited | success
  nextAllowedMs: null,
  serverOffsetMs: 0,
  submitting: false,
  showErrors: false,
  pending: null, // { key, fingerprint } — 같은 내용 재시도에는 같은 idempotency key
  remainingTimer: 0,
  lastStatusAt: 0,
  statusSeq: 0,
  metaFrame: 0,
  motionPref: null,
  confirmedWait: false, // 서버가 제한 중이라고 확인해 준 적이 있는지 (다시 쓸 수 있게 됐을 때만 알림)
};

const els = {};
const root = document.documentElement;
const reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

/* ---------- 시간 ---------- */
const serverNow = () => Date.now() + state.serverOffsetMs;
const pad = (n) => String(n).padStart(2, '0');

function applyServerTime(iso) {
  const ms = Date.parse(iso);
  if (Number.isFinite(ms)) state.serverOffsetMs = ms - Date.now();
}

// 분 단위는 올림: 표시한 시각이 되면 반드시 보낼 수 있도록
function formatKst(ms) {
  const d = new Date(Math.ceil(ms / 60000) * 60000 + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} KST`;
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}시간 ${pad(m)}분 ${pad(s)}초` : `${m}분 ${pad(s)}초`;
}

function setNextAllowed(ms) {
  state.nextAllowedMs = Number.isFinite(ms) ? ms : null;
  if (state.nextAllowedMs) storage.set(STORAGE_KEYS.nextAllowedAt, new Date(state.nextAllowedMs).toISOString());
  else storage.remove(STORAGE_KEYS.nextAllowedAt);
}

function readCachedNextAllowed() {
  const ms = Date.parse(storage.get(STORAGE_KEYS.nextAllowedAt) || '');
  return Number.isFinite(ms) && ms > Date.now() ? ms : null;
}

/* ---------- 알림 ---------- */
function announce(text) {
  els.live.textContent = '';
  setTimeout(() => { els.live.textContent = text; }, 60);
}

function showFormError(text) {
  els.formError.textContent = text;
  els.formError.hidden = false;
}

function hideFormError() {
  els.formError.hidden = true;
  els.formError.textContent = '';
}

function showStatusNote(text) {
  els.formStatus.textContent = text || '';
  els.formStatus.hidden = !text;
}

/* ---------- 화면 전환 ---------- */
function updateSubmitButton() {
  const btn = els.submitBtn;
  if (state.submitting) btn.textContent = LABELS.submitting;
  else if (state.view === 'checking') btn.textContent = LABELS.checking;
  else btn.textContent = LABELS.submit;
  btn.disabled = state.submitting || state.view !== 'form';
}

function showView(view, { focus = null, message = '' } = {}) {
  state.view = view;
  const panelView = view === 'limited' || view === 'success';
  els.form.hidden = panelView;
  els.successPanel.hidden = view !== 'success';
  els.limitedPanel.hidden = view !== 'limited';
  if (view === 'limited') {
    els.limitedKept.hidden = !(els.name.value.trim() || els.content.value.trim());
  }
  if (panelView) {
    const next = state.nextAllowedMs ? formatKst(state.nextAllowedMs) : '';
    const timeEl = view === 'success' ? els.successNext : els.limitedNext;
    timeEl.textContent = next;
    timeEl.dateTime = state.nextAllowedMs ? new Date(state.nextAllowedMs).toISOString() : '';
  } else {
    showStatusNote('');
  }
  updateSubmitButton();
  startRemainingTicker();
  if (focus) focus.focus();
  if (message) announce(message);
}

function startRemainingTicker() {
  clearTimeout(state.remainingTimer);
  if (state.view !== 'limited' && state.view !== 'success') return;
  const el = state.view === 'success' ? els.successRemaining : els.limitedRemaining;
  const left = (state.nextAllowedMs || 0) - serverNow();
  if (left <= 0) {
    el.textContent = formatRemaining(0);
    // 서버에서 다시 확인한 뒤에만 입력 화면으로 돌아감
    state.remainingTimer = setTimeout(() => checkStatus({ force: true }), 1000);
    return;
  }
  el.textContent = formatRemaining(left);
  state.remainingTimer = setTimeout(startRemainingTicker, ((left - 1) % 1000) + 1);
}

/* ---------- 서버 상태 확인 ---------- */
async function checkStatus({ force = false } = {}) {
  if (state.submitting) return;
  const now = Date.now();
  if (!force && now - state.lastStatusAt < STATUS_RECHECK_GAP_MS) return;
  state.lastStatusAt = now;
  const seq = ++state.statusSeq;

  let data = null;
  try {
    const res = await fetch(API.status, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) data = null;
  } catch {
    data = null;
  }
  if (seq !== state.statusSeq || state.submitting) return;

  if (!data) {
    if (state.view === 'checking') {
      showView('form');
      showStatusNote('작성 가능 여부를 확인하지 못했어요. 보내기를 누르면 다시 확인해요.');
    }
    return;
  }

  applyServerTime(data.serverNow);
  const next = data.nextAllowedAt ? Date.parse(data.nextAllowedAt) : null;
  setNextAllowed(next);

  if (next && next > serverNow()) {
    state.confirmedWait = true;
    if (state.view === 'success') showView('success');
    else if (state.view === 'limited') showView('limited');
    else showView('limited', { message: `이 브라우저에서 최근에 보낸 편지가 있어요. 다음 편지는 ${formatKst(next)}부터 보낼 수 있어요.` });
  } else if (state.view !== 'form') {
    showView('form', state.confirmedWait ? { message: '이제 새 편지를 보낼 수 있어요.' } : {});
    state.confirmedWait = false;
  }
}

/* ---------- 입력 안내 (줄 수 / 용량 / 오류) ---------- */
function setFieldError(input, el, message) {
  el.textContent = message || '';
  el.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function renderFieldErrors(result) {
  const nameCode = result.errors.senderName;
  const contentCode = result.errors.content;
  setFieldError(els.name, els.nameError, nameCode && FIELD_MESSAGES[nameCode] ? FIELD_MESSAGES[nameCode](result.stats) : '');
  setFieldError(els.content, els.contentError, contentCode && FIELD_MESSAGES[contentCode] ? FIELD_MESSAGES[contentCode](result.stats) : '');
}

function readForm() {
  return validateLetter({ senderName: els.name.value, content: els.content.value });
}

function updateMeta() {
  const result = readForm();
  const { nameChars, lines, bytes } = result.stats;
  els.senderCount.textContent = `${fmt(nameChars)} / ${LETTER_RULES.nameMaxChars}`;
  els.lines.textContent = fmt(els.content.value === '' ? 0 : lines);
  els.bytes.textContent = `${kb(bytes)}KB`;
  els.senderCount.classList.toggle('is-over', nameChars > LETTER_RULES.nameMaxChars);
  els.meta.classList.toggle('is-over', lines > LETTER_RULES.contentMaxLines || bytes > LETTER_RULES.contentMaxBytes);
  if (state.showErrors) renderFieldErrors(result);
}

function scheduleMeta() {
  if (state.metaFrame) return;
  state.metaFrame = requestAnimationFrame(() => {
    state.metaFrame = 0;
    updateMeta();
  });
}

/* ---------- 보내기 ---------- */
function newIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 네트워크 오류·일시 장애는 같은 key 로 한 번 더 시도 (서버가 중복 저장을 막음)
async function sendLetter(value, key) {
  const body = JSON.stringify({ senderName: value.senderName, content: value.content, idempotencyKey: key });
  let networkRetried = false;
  let cookieRetried = false;
  for (;;) {
    let res;
    let data = null;
    try {
      res = await fetch(API.submit, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      data = await res.json().catch(() => null);
    } catch {
      if (!networkRetried) {
        networkRetried = true;
        await wait(RETRY_DELAY_MS);
        continue;
      }
      return { status: 0, data: { code: 'network' } };
    }
    // 쿠키가 없어서 방금 새로 발급됐다면 한 번만 다시 시도
    if (res.status === 428 && !cookieRetried) {
      cookieRetried = true;
      continue;
    }
    if (res.status >= 502 && res.status <= 504 && !networkRetried) {
      networkRetried = true;
      await wait(RETRY_DELAY_MS);
      continue;
    }
    return { status: res.status, data: data || {} };
  }
}

function setSubmitting(on) {
  state.submitting = on;
  if (on) state.statusSeq++;
  els.form.setAttribute('aria-busy', String(on));
  els.name.readOnly = on;
  els.content.readOnly = on;
  updateSubmitButton();
}

function focusFirstInvalid(errors) {
  if (errors.senderName) els.name.focus();
  else if (errors.content) els.content.focus();
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.submitting || state.view !== 'form') return;
  hideFormError();
  showStatusNote('');
  state.showErrors = true;

  const result = readForm();
  renderFieldErrors(result);
  if (!result.ok) {
    focusFirstInvalid(result.errors);
    return;
  }

  const fingerprint = `${result.value.senderName || ''}\u0000${result.value.content}`;
  if (!state.pending || state.pending.fingerprint !== fingerprint) {
    state.pending = { key: newIdempotencyKey(), fingerprint };
  }

  setSubmitting(true);
  let outcome;
  try {
    outcome = await sendLetter(result.value, state.pending.key);
  } finally {
    setSubmitting(false);
  }
  const { status, data } = outcome;

  if ((status === 201 || status === 200) && data.ok) {
    applyServerTime(data.serverNow);
    setNextAllowed(Date.parse(data.nextAllowedAt));
    state.pending = null;
    state.showErrors = false;
    state.confirmedWait = true;
    els.name.value = '';
    els.content.value = '';
    updateMeta();
    showView('success', {
      focus: els.successTitle,
      message: `편지를 잘 받았어요. 관리자 확인 후 모카에게 전달할게요. 다음 편지는 ${formatKst(state.nextAllowedMs)}부터 보낼 수 있어요.`,
    });
    return;
  }

  if (status === 429 && data.nextAllowedAt) {
    applyServerTime(data.serverNow);
    setNextAllowed(Date.parse(data.nextAllowedAt));
    state.confirmedWait = true;
    showView('limited', {
      focus: els.limitedTitle,
      message: `이 브라우저에서 최근에 보낸 편지가 있어요. 다음 편지는 ${formatKst(state.nextAllowedMs)}부터 보낼 수 있어요.`,
    });
    return;
  }

  if (status === 400 && data.code === 'validation_failed' && data.fields) {
    const local = readForm();
    renderFieldErrors({ errors: data.fields, stats: local.stats });
    focusFirstInvalid(data.fields);
    return;
  }

  showFormError(SERVER_MESSAGES[data.code] || SERVER_MESSAGES.default);
}

/* ---------- 움직임 설정 ---------- */
function isReducedMotion() {
  if (state.motionPref === 'on') return false;
  if (state.motionPref === 'off') return true;
  return Boolean(reduceQuery && reduceQuery.matches);
}

function applyMotion() {
  const reduced = isReducedMotion();
  root.classList.toggle('motion-off', reduced);
  root.classList.toggle('motion-on', !reduced);
  els.motionBtn.textContent = reduced ? LABELS.motionOn : LABELS.motionOff;
}

function readMotionPref() {
  const saved = storage.get(STORAGE_KEYS.motion);
  return saved === 'on' || saved === 'off' ? saved : null;
}

/* ---------- 시작 ---------- */
function init() {
  const byId = (id) => document.getElementById(id);
  Object.assign(els, {
    emojiLayer: byId('emoji-layer'),
    form: byId('letter-form'),
    name: byId('sender-name'),
    content: byId('letter-content'),
    senderCount: byId('sender-count'),
    nameError: byId('sender-error'),
    contentError: byId('content-error'),
    meta: byId('content-meta'),
    lines: byId('content-lines'),
    bytes: byId('content-bytes'),
    formError: byId('form-error'),
    formStatus: byId('form-status'),
    submitBtn: byId('submit-btn'),
    successPanel: byId('success-panel'),
    successTitle: byId('success-title'),
    successNext: byId('success-next'),
    successRemaining: byId('success-remaining'),
    limitedPanel: byId('limited-panel'),
    limitedTitle: byId('limited-title'),
    limitedNext: byId('limited-next'),
    limitedRemaining: byId('limited-remaining'),
    limitedKept: byId('limited-kept'),
    motionBtn: byId('motion-btn'),
    live: byId('live'),
  });

  state.motionPref = readMotionPref();
  applyMotion();
  els.motionBtn.addEventListener('click', () => {
    state.motionPref = isReducedMotion() ? 'on' : 'off';
    storage.set(STORAGE_KEYS.motion, state.motionPref);
    applyMotion();
  });
  if (reduceQuery) {
    if (reduceQuery.addEventListener) reduceQuery.addEventListener('change', applyMotion);
    else if (reduceQuery.addListener) reduceQuery.addListener(applyMotion);
  }

  const emojiLayer = createEmojiLayer(els.emojiLayer);
  window.addEventListener('pagehide', (e) => {
    if (!e.persisted) emojiLayer.destroy();
  });

  els.form.addEventListener('submit', onSubmit);
  els.name.addEventListener('input', scheduleMeta);
  els.content.addEventListener('input', scheduleMeta);

  // 탭 복귀·다른 탭의 변경 시 서버 상태를 다시 확인
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkStatus();
  });
  window.addEventListener('focus', () => checkStatus());
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) checkStatus({ force: true });
  });
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.nextAllowedAt || e.key === null) checkStatus({ force: true });
    if (e.key === STORAGE_KEYS.motion) {
      state.motionPref = readMotionPref();
      applyMotion();
    }
  });

  updateMeta();
  const cached = readCachedNextAllowed();
  if (cached) {
    state.nextAllowedMs = cached;
    showView('limited');
  } else {
    showView('checking');
  }
  checkStatus({ force: true });
}

init();
