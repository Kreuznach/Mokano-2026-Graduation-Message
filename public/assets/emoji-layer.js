// 카운트다운 페이지의 emoji layer(fall / sway / rise / glow)를 편지 페이지용으로 분리한 모듈
export const EMOJI_CONFIG = {
  desktopMinWidth: 768,
  // 가운데 콘텐츠 기둥 너비(px). 이 영역을 피해 가장자리에 배치
  columnWidth: 600,
  emojis: {
    sad: ['🥹', '😢', '🥲', '😭', '🥺', '😿', '💧'],
    cheer: ['💜', '✨', '🫶', '🌷', '💌', '🤍'],
  },
  // 아쉬움 70 : 응원 30
  counts: {
    mobile: { sad: 7, cheer: 3 },
    desktop: { sad: 14, cheer: 6 },
  },
  durationSec: [8, 14],
};

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function makeGroup(group, count) {
  const chars = EMOJI_CONFIG.emojis[group];
  const isSad = group === 'sad';
  const [minDur, maxDur] = EMOJI_CONFIG.durationSec;
  return Array.from({ length: count }, (_, i) => ({
    group,
    char: chars[i % chars.length],
    variant: isSad ? (i % 2 ? 'sway' : 'fall') : (i % 2 ? 'glow' : 'rise'),
    size: isSad ? rand(22, 38) : rand(20, 30),
    alpha: isSad ? rand(0.48, 0.6) : rand(0.4, 0.5),
    duration: rand(minDur, maxDur),
  }));
}

function makeSlots(count, width) {
  const freeSide = ((width - EMOJI_CONFIG.columnWidth) / 2 / width) * 100;
  const inner = Math.max(12, Math.min(30, freeSide - 2));
  const sides = [Math.ceil(count / 2), Math.floor(count / 2)];
  const slots = [];
  sides.forEach((m, side) => {
    const band = 86 / m;
    for (let j = 0; j < m; j++) {
      const offset = rand(2, inner);
      slots.push({ x: side === 0 ? offset : 100 - offset, y: 2 + band * j + rand(0.15, 0.85) * band });
    }
  });
  return slots;
}

/** 페이지가 열린 뒤 한 번 만들고, 화면 너비가 바뀔 때만 다시 배치합니다. 입력으로는 다시 만들지 않습니다. */
export function createEmojiLayer(layer) {
  let layoutKey = '';
  let layoutWidth = 0;
  let resizeId = 0;
  const root = document.documentElement;

  function build() {
    const width = window.innerWidth;
    const key = width >= EMOJI_CONFIG.desktopMinWidth ? 'desktop' : 'mobile';
    if (key === layoutKey && width === layoutWidth) return;
    layoutKey = key;
    layoutWidth = width;

    const counts = EMOJI_CONFIG.counts[key];
    const items = shuffle([...makeGroup('sad', counts.sad), ...makeGroup('cheer', counts.cheer)]);
    const slots = makeSlots(items.length, width);
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const el = document.createElement('span');
      el.className = `emoji emoji--${item.group} is-${item.variant}`;
      el.textContent = item.char;
      el.style.setProperty('--x', slots[i].x.toFixed(1));
      el.style.setProperty('--y', slots[i].y.toFixed(1));
      el.style.setProperty('--size', `${item.size.toFixed(0)}px`);
      el.style.setProperty('--alpha', item.alpha.toFixed(2));
      el.style.setProperty('--dur', `${item.duration.toFixed(1)}s`);
      el.style.setProperty('--delay', `${(-rand(0, item.duration)).toFixed(1)}s`);
      frag.appendChild(el);
    });
    layer.replaceChildren(frag);
    layer.dataset.layout = key;
  }

  function onResize() {
    clearTimeout(resizeId);
    resizeId = setTimeout(build, 150);
  }

  function onVisibility() {
    root.classList.toggle('is-page-hidden', document.hidden);
  }

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  build();
  onVisibility();

  return {
    destroy() {
      clearTimeout(resizeId);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      root.classList.remove('is-page-hidden');
      layer.replaceChildren();
    },
  };
}
