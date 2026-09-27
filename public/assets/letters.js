import { LETTER_RULES, validateLetter } from './letter-rules.js';
import { createEmojiLayer } from './emoji-layer.js';
import { I18N, LANGS } from './letters-i18n.js';

const API = { status: '/api/letters/status', submit: '/api/letters' };
// 서버가 알려 준 "다음 작성 가능 시각"만 캐시 (화면 복원용. 제한의 최종 판단은 서버)
const STORAGE_KEYS = {
  nextAllowedAt: 'mokano:letters:nextAllowedAt',
  motion: 'mokano:letters:motion',
  lang: 'mokano:letters:lang',
};
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATUS_RECHECK_GAP_MS = 4000;
const RETRY_DELAY_MS = 1200;

const kb = (bytes) => (Math.ceil((bytes / 1024) * 10) / 10).toFixed(bytes >= 10 * 1024 ? 0 : 1);
const t = () => I18N[state.lang];

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
  lang: 'ko',
  formErrorCode: '', // 언어를 바꿨을 때 같은 오류를 다시 번역해 보여 주기 위함
  statusNoteKey: '',
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
  return t().remaining(h, m, s);
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

function renderFormError() {
  const code = state.formErrorCode;
  els.formError.textContent = code ? t().server[code] || t().server.default : '';
  els.formError.hidden = !code;
}

function showFormError(code) {
  state.formErrorCode = code || 'default';
  renderFormError();
}

function hideFormError() {
  state.formErrorCode = '';
  renderFormError();
}

function showStatusNote(key) {
  state.statusNoteKey = key || '';
  els.formStatus.textContent = key ? t()[key] : '';
  els.formStatus.hidden = !key;
}

/* ---------- 화면 전환 ---------- */
function updateSubmitButton() {
  const btn = els.submitBtn;
  if (state.submitting) btn.textContent = t().submitting;
  else if (state.view === 'checking') btn.textContent = t().checking;
  else btn.textContent = t().submit;
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
      showStatusNote('statusCheckFailed');
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
    else showView('limited', { message: t().announceLimited(formatKst(next)) });
  } else if (state.view !== 'form') {
    showView('form', state.confirmedWait ? { message: t().announceReady } : {});
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

function fieldMessage(code, stats) {
  const fn = code && t().field[code];
  return fn ? fn(stats, kb(stats.bytes)) : '';
}

function renderFieldErrors(result) {
  setFieldError(els.name, els.nameError, fieldMessage(result.errors.senderName, result.stats));
  setFieldError(els.content, els.contentError, fieldMessage(result.errors.content, result.stats));
}

function readForm() {
  return validateLetter({ senderName: els.name.value, content: els.content.value });
}

function updateMeta() {
  const result = readForm();
  const { nameChars, lines, bytes } = result.stats;
  els.senderCount.textContent = t().nameCount(nameChars, LETTER_RULES.nameMaxChars);
  els.meta.textContent = t().meta(els.content.value === '' ? 0 : lines, kb(bytes));
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
      message: t().announceSuccess(formatKst(state.nextAllowedMs)),
    });
    return;
  }

  if (status === 429 && data.nextAllowedAt) {
    applyServerTime(data.serverNow);
    setNextAllowed(Date.parse(data.nextAllowedAt));
    state.confirmedWait = true;
    showView('limited', {
      focus: els.limitedTitle,
      message: t().announceLimited(formatKst(state.nextAllowedMs)),
    });
    return;
  }

  if (status === 400 && data.code === 'validation_failed' && data.fields) {
    const local = readForm();
    renderFieldErrors({ errors: data.fields, stats: local.stats });
    focusFirstInvalid(data.fields);
    return;
  }

  showFormError(data.code);
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
  els.motionBtn.textContent = reduced ? t().motionOn : t().motionOff;
}

function readMotionPref() {
  const saved = storage.get(STORAGE_KEYS.motion);
  return saved === 'on' || saved === 'off' ? saved : null;
}

/* ---------- 언어 (한국어 / 日本語) ---------- */
// 우선순위: 주소의 ?lang= → 저장한 선택 → 브라우저 언어 → 한국어
function initialLang() {
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (LANGS.includes(fromUrl)) return fromUrl;
  const saved = storage.get(STORAGE_KEYS.lang);
  if (LANGS.includes(saved)) return saved;
  const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  return prefs.some((l) => /^ja\b/i.test(l)) ? 'ja' : 'ko';
}

function applyLanguage(lang) {
  state.lang = LANGS.includes(lang) ? lang : 'ko';
  const dict = t();
  root.lang = dict.htmlLang;
  document.title = dict.pageTitle;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = dict[el.dataset.i18n];
    if (typeof value === 'string' && el.textContent !== value) el.textContent = value;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', dict[el.dataset.i18nAria]);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', dict[el.dataset.i18nPlaceholder]);
  });
  els.langButtons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.lang === state.lang)));

  updateSubmitButton();
  applyMotion();
  updateMeta();
  renderFormError();
  showStatusNote(state.statusNoteKey);
  startRemainingTicker();
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
    langButtons: Array.from(document.querySelectorAll('[data-lang]')),
    live: byId('live'),
  });

  state.lang = initialLang();
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

  els.langButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      applyLanguage(btn.dataset.lang);
      storage.set(STORAGE_KEYS.lang, state.lang);
    });
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
    if (e.key === STORAGE_KEYS.lang && LANGS.includes(e.newValue)) applyLanguage(e.newValue);
  });

  applyLanguage(state.lang);
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
