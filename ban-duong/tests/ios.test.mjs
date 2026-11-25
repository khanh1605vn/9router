// iPhone, iPad (js/ios.js): nhận ra máy và trình duyệt, chế độ mở từ Màn hình chính, gợi ý cài, lưu ý trong Cài đặt;
// mồi giọng đọc chỉ trong lần bấm thật (js/voice.js); báo trình duyệt quá cũ (js/compat.js); thẻ iOS trong index.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  detectApple,
  INSTALL_TEXT,
  installHint,
  installSteps,
  iphoneNotes,
  isStandalone,
  requestPersistence,
  voiceMissingHint,
} from '../js/ios.js';
import { DEFAULT_SETTINGS } from '../js/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneHome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  iphoneEdge:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.2592.56 Mobile/15E148 Safari/605.1.15',
  iphoneFacebook:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.94;FBBV/600000000]',
  iphoneZalo:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/24.06.01',
  iphoneWebView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  ipadOld:
    'Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidApp:
    'Mozilla/5.0 (Linux; Android 14; SM-A546E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
};

/** Môi trường giả: navigator (userAgent, maxTouchPoints, standalone) và matchMedia theo danh sách display-mode khớp. */
function env(userAgent, { touch = 5, standalone, modes = [], storage } = {}) {
  const navigator = { userAgent, maxTouchPoints: touch };
  if (standalone !== undefined) navigator.standalone = standalone;
  if (storage) navigator.storage = storage;
  return {
    navigator,
    matchMedia: (q) => ({ matches: modes.some((m) => q === `(display-mode: ${m})`) }),
  };
}

test('nhận ra Safari trên iPhone, chưa cài: gợi ý bấm Chia sẻ rồi Thêm vào Màn hình chính', () => {
  const a = detectApple(env(UA.iphoneSafari, { standalone: false }));
  assert.deepEqual(a, { ios: true, ipad: false, browser: 'safari', standalone: false });
  const h = installHint(a, false);
  assert.equal(h.kind, 'safari');
  assert.equal(h.text, 'Để dùng như ứng dụng: bấm nút Chia sẻ rồi chọn Thêm vào Màn hình chính');
});

test('đã mở từ Màn hình chính (navigator.standalone hay display-mode): không gợi ý', () => {
  const byNav = detectApple(env(UA.iphoneHome, { standalone: true }));
  assert.equal(byNav.standalone, true);
  assert.equal(byNav.browser, 'home');
  assert.equal(installHint(byNav), null);
  // iOS mới cũng báo display-mode: standalone; UA của Safari mà vẫn standalone thì cũng không gợi ý.
  const byMedia = detectApple(env(UA.iphoneSafari, { modes: ['standalone'] }));
  assert.equal(byMedia.standalone, true);
  assert.equal(installHint(byMedia), null);
});

test('người dùng đã ẩn gợi ý: không hiện nữa (lưu trong cài đặt, mặc định chưa ẩn)', () => {
  assert.equal(DEFAULT_SETTINGS.iosHintDismissed, false);
  const a = detectApple(env(UA.iphoneSafari));
  assert.ok(installHint(a, DEFAULT_SETTINGS.iosHintDismissed));
  assert.equal(installHint(a, true), null);
});

test('Chrome, Firefox, Edge trên iPhone (iOS 16.4 trở lên): cài ngay qua nút Chia sẻ của trình duyệt, không bắt sang Safari', () => {
  for (const [ua, name] of [
    [UA.iphoneChrome, 'chrome'],
    [UA.iphoneFirefox, 'firefox'],
    [UA.iphoneEdge, 'edge'],
  ]) {
    const a = detectApple(env(ua));
    assert.equal(a.ios, true, name);
    assert.equal(a.browser, name);
    const h = installHint(a);
    assert.equal(h.kind, 'share', name);
    assert.equal(h.text, INSTALL_TEXT.share);
    assert.doesNotMatch(h.text, /Safari/);
    const steps = installSteps(a);
    assert.match(steps[0], /^Bấm nút Chia sẻ của trình duyệt/, name);
    assert.ok(!steps.some((s) => /^Mở trang này bằng Safari/.test(s)), name);
    assert.ok(steps.some((s) => s.includes('Thêm vào Màn hình chính')), name);
    // Còn đường lui về Safari khi trình duyệt không có mục này.
    assert.ok(steps.some((s) => /bằng Safari/.test(s)), name);
  }
});

test('trình duyệt lạ trên iPhone (Opera, ứng dụng Google…): vẫn bảo mở bằng Safari để cài', () => {
  const opera =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPT/4.6.0 Mobile/15E148 Safari/604.1';
  const google =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/321.0.645937015 Mobile/15E148 Safari/604.1';
  for (const [ua, name] of [
    [opera, 'opera'],
    [google, 'google'],
  ]) {
    const a = detectApple(env(ua));
    assert.equal(a.browser, name);
    const h = installHint(a);
    assert.equal(h.kind, 'open-in-safari', name);
    assert.equal(h.text, INSTALL_TEXT.other);
    assert.match(installSteps(a)[0], /^Mở trang này bằng Safari/);
  }
});

test('trình duyệt trong Facebook, Zalo hay ứng dụng tự nhúng WebKit: bảo mở bằng Safari', () => {
  for (const [ua, name] of [
    [UA.iphoneFacebook, 'in-app'],
    [UA.iphoneZalo, 'in-app'],
    [UA.iphoneWebView, 'webview'],
  ]) {
    const a = detectApple(env(ua, { standalone: false }));
    assert.equal(a.browser, name, ua);
    assert.equal(installHint(a).text, INSTALL_TEXT.inApp);
    assert.match(installSteps(a)[0], /^Mở trang này bằng Safari/);
  }
});

test('iPad báo mình là Macintosh: nhận ra nhờ màn hình cảm ứng; máy Mac thật thì không', () => {
  const ipad = detectApple(env(UA.ipadDesktop, { touch: 5 }));
  assert.equal(ipad.ios, true);
  assert.equal(ipad.ipad, true);
  assert.equal(ipad.browser, 'safari');
  assert.match(installSteps(ipad)[0], /góc trên/);
  assert.equal(detectApple(env(UA.ipadOld)).ipad, true);
  const mac = detectApple(env(UA.ipadDesktop, { touch: 0 }));
  assert.equal(mac.ios, false);
  assert.equal(installHint(mac), null);
});

test('Android (Chrome và ứng dụng Android): không bao giờ có gợi ý hay lưu ý iPhone', () => {
  for (const ua of [UA.androidChrome, UA.androidApp]) {
    const a = detectApple(env(ua));
    assert.equal(a.ios, false);
    assert.equal(a.browser, null);
    assert.equal(installHint(a), null);
  }
  assert.match(voiceMissingHint(detectApple(env(UA.androidChrome))), /Chuyển văn bản thành giọng nói/);
});

test('môi trường thiếu navigator hay matchMedia ném lỗi: không ném, coi như không phải iOS, chưa cài', () => {
  assert.deepEqual(detectApple({}), { ios: false, ipad: false, browser: null, standalone: false });
  assert.equal(detectApple(undefined).ios, false);
  const bad = {
    navigator: { userAgent: UA.iphoneSafari, maxTouchPoints: 5 },
    matchMedia() {
      throw new Error('x');
    },
  };
  assert.equal(isStandalone(bad), false);
  assert.equal(detectApple(bad).browser, 'safari');
  assert.equal(installHint(null), null);
});

test('các bước cài: Safari bắt đầu từ nút Chia sẻ, có cả cách khi nút nằm sau nút ba chấm', () => {
  const steps = installSteps(detectApple(env(UA.iphoneSafari)));
  assert.match(steps[0], /^Bấm nút Chia sẻ/);
  assert.match(steps[0], /ba chấm/);
  assert.ok(steps.some((s) => s.includes('Thêm vào Màn hình chính')));
  assert.ok(steps.some((s) => /vị trí/.test(s)));
});

test('lưu ý "Trên iPhone": nói rõ không OBD, chỉ chạy khi mở trên màn hình, không CarPlay, giữ màn hình sáng', () => {
  const browser = iphoneNotes(detectApple(env(UA.iphoneSafari)));
  const all = browser.join('\n');
  assert.match(all, /OBD Bluetooth/);
  assert.match(all, /chỉ chạy khi Bạn Đường đang mở trên màn hình/);
  assert.match(all, /tắt màn hình/);
  assert.match(all, /CarPlay/);
  assert.match(all, /iOS 16\.4/);
  assert.match(all, /18\.4/);
  // Chưa cài: nhắc Safari có thể xoá dữ liệu sau 7 ngày; đã cài thì bỏ câu này.
  assert.match(browser[0], /7 ngày/);
  const home = iphoneNotes(detectApple(env(UA.iphoneHome, { standalone: true })));
  assert.ok(!home.join('\n').includes('7 ngày'));
  assert.equal(home.length, browser.length - 1);
  assert.match(voiceMissingHint(detectApple(env(UA.iphoneSafari))), /Nội dung được đọc/);
});

test('chữ hiển thị: viết hoa kiểu tiếng Việt (không viết hoa toàn bộ), có dấu, kết thúc gọn', () => {
  const a = detectApple(env(UA.iphoneChrome));
  const texts = [
    ...Object.values(INSTALL_TEXT),
    ...installSteps(a),
    ...iphoneNotes(a),
    voiceMissingHint(a),
  ];
  for (const t of texts) {
    assert.ok(!/\b[A-ZĐÂĂÊÔƠƯ]{4,}\b/.test(t.replace(/\b(?:OBD|iOS|CarPlay)\b/g, '')), `chữ hoa toàn bộ: ${t}`);
    assert.ok(/[à-ỹđ]/i.test(t), `thiếu dấu tiếng Việt: ${t}`);
    assert.equal(t, t.trim());
  }
});

test('xin giữ dữ liệu lâu dài: đã giữ thì thôi, có thì xin, không có hay lỗi thì không ném', async () => {
  let asked = 0;
  const kept = env(UA.iphoneHome, { storage: { persisted: async () => true, persist: async () => void asked++ } });
  assert.equal(await requestPersistence(kept), true);
  assert.equal(asked, 0);
  const fresh = env(UA.iphoneHome, { storage: { persisted: async () => false, persist: async () => (asked++, true) } });
  assert.equal(await requestPersistence(fresh), true);
  assert.equal(asked, 1);
  assert.equal(await requestPersistence(env(UA.iphoneHome)), null);
  const broken = env(UA.iphoneHome, {
    storage: {
      persist: async () => {
        throw new Error('x');
      },
    },
  });
  assert.equal(await requestPersistence(broken), false);
});

// ---------- Mồi giọng đọc trong lần bấm (js/voice.js) ----------

/** Nạp một bản voice.js mới với speechSynthesis, AudioContext và navigator.userActivation giả. */
async function loadVoice({ activation = undefined, audioState = 'suspended', voices = [] } = {}) {
  const spoken = [];
  const ctxs = [];
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    resumed: 0,
    voices,
    getVoices() {
      return this.voices;
    },
    speak: (u) => spoken.push(u),
    cancel() {},
    resume() {
      this.resumed++;
      this.paused = false;
    },
    addEventListener() {},
  };
  class FakeAudioContext {
    constructor() {
      this.state = audioState;
      this.resumes = 0;
      ctxs.push(this);
    }
    resume() {
      this.resumes++;
      if (this.resumeBlocked) return new Promise(() => {}); // trình duyệt giữ resume() tới lần chạm sau
      this.state = 'running';
      return Promise.resolve();
    }
    get currentTime() {
      return 0;
    }
    get destination() {
      return {};
    }
    createOscillator() {
      this.tones = (this.tones || 0) + 1;
      return { frequency: {}, connect: (x) => x, start() {}, stop() {} };
    }
    createGain() {
      const noop = () => {};
      return { gain: { setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop }, connect: (x) => x };
    }
  }
  globalThis.window = { speechSynthesis: synth, AudioContext: FakeAudioContext };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: activation === undefined ? {} : { userActivation: activation },
    configurable: true,
    writable: true,
  });
  const mod = await import(`../js/voice.js?case=${Math.random()}`);
  return { voice: mod.voice, PRIORITY: mod.PRIORITY, synth, spoken, ctxs };
}

test('iOS: lúc vừa chạm (chưa có thao tác người dùng) chưa mồi giọng; lần bấm sau mới mồi, và chỉ mồi một lần', async () => {
  const activation = { isActive: false };
  const { voice, spoken, ctxs } = await loadVoice({ activation });
  assert.equal(voice.unlock(), false, 'pointerdown trên iOS: userActivation.isActive = false');
  assert.equal(spoken.length, 0);
  assert.equal(voice.unlocked, false);
  activation.isActive = true; // click
  assert.equal(voice.unlock(), true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, ' ');
  assert.equal(spoken[0].volume, 0);
  assert.equal(ctxs.length, 1);
  assert.equal(ctxs[0].state, 'running');
  assert.equal(voice.unlocked, true);
  voice.unlock();
  assert.equal(spoken.length, 1, 'không mồi lại');
});

test('trình duyệt không có navigator.userActivation: mồi ngay lần gọi đầu như trước', async () => {
  const { voice, spoken } = await loadVoice();
  assert.equal(voice.unlock(), true);
  assert.equal(spoken.length, 1);
});

test('âm báo bị iOS ngắt (interrupted, sau cuộc gọi): lần bấm sau mở lại', async () => {
  const { voice, ctxs } = await loadVoice({ activation: { isActive: true }, audioState: 'running' });
  voice.unlock();
  ctxs[0].state = 'interrupted';
  assert.equal(voice.unlocked, false);
  voice.unlock();
  assert.equal(ctxs[0].resumes, 1);
  assert.equal(voice.unlocked, true);
});

test('âm báo bị iOS dừng sau cuộc gọi khi đang lái: trang hiện lại hay âm báo kế tiếp tự mở lại, không cần bấm nút', async () => {
  const { voice, ctxs } = await loadVoice({ activation: { isActive: true }, audioState: 'running' });
  voice.unlock();
  const ctx = ctxs[0];
  // Cuộc gọi: 'interrupted'; xong cuộc gọi WebKit có khi để 'suspended' mà không tự chạy lại.
  ctx.state = 'interrupted';
  voice.wake(); // trang hiện lại (visibilitychange trong js/main.js)
  assert.equal(ctx.resumes, 1);
  assert.equal(ctx.state, 'running');

  ctx.state = 'suspended';
  ctx.tones = 0;
  voice.chime('over');
  assert.equal(ctx.resumes, 2, 'âm báo gọi resume() trước khi phát');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.tones, 3, 'mở lại xong thì phát đủ ba tiếng quá tốc độ');

  // Đang chạy: không gọi resume() thừa.
  voice.chime('turn');
  assert.equal(ctx.resumes, 2);
  assert.equal(ctx.tones, 4);

  // Trình duyệt giữ resume() mãi: không phát, không ném lỗi; đã đóng thì thôi hẳn.
  ctx.state = 'suspended';
  ctx.resumeBlocked = true;
  voice.chime('alert');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.tones, 4);
  ctx.state = 'closed';
  const before = ctx.resumes;
  voice.chime('alert');
  voice.wake();
  assert.equal(ctx.resumes, before);
});

test('js/main.js: không bao giờ gỡ trình nghe mở khoá âm thanh, để lần chạm bất kỳ sau cuộc gọi mở lại âm báo', () => {
  const main = read('js/main.js');
  const at = main.indexOf('const unlockAudio');
  assert.ok(at > 0);
  const block = main.slice(at, main.indexOf("window.addEventListener('popstate'", at));
  assert.match(block, /if \(!voice\.unlocked\) voice\.unlock\(\)/);
  assert.ok(!/removeEventListener\([^)]*unlockAudio/.test(main), 'không gỡ unlockAudio');
  for (const t of ['pointerdown', 'pointerup', 'click', 'keydown']) assert.ok(block.includes(`'${t}'`), t);
  assert.match(main, /visibilityState === 'visible'\) voice\.wake\(\)/);
});

test('danh sách giọng nạp chậm: câu đầu tiên sau khi có giọng tiếng Việt dùng giọng đó; trang hiện lại thì đọc tiếp', async () => {
  const { voice, PRIORITY, synth, spoken } = await loadVoice({ activation: { isActive: true } });
  assert.equal(voice.hasVietnamese, null, 'chưa có danh sách giọng');
  const linh = { lang: 'vi-VN', name: 'Linh', localService: true };
  synth.voices = [{ lang: 'en-US', name: 'Samantha', localService: true }, linh];
  voice.speak('Phía trước 100 mét, cấm rẽ trái', PRIORITY.alert);
  assert.equal(spoken.at(-1).voice, linh);
  assert.equal(spoken.at(-1).lang, 'vi-VN');
  synth.paused = true;
  voice.wake();
  assert.equal(synth.resumed, 1);
  voice.wake();
  assert.equal(synth.resumed, 1, 'không tạm dừng thì không gọi resume');
});

test('máy không có giọng tiếng Việt: vẫn đọc với lang vi-VN để máy tự chọn, và báo chưa có giọng', async () => {
  const { voice, PRIORITY, synth, spoken } = await loadVoice({ activation: { isActive: true } });
  synth.voices = [{ lang: 'en-US', name: 'Samantha', localService: true }];
  assert.equal(voice.hasVietnamese, false);
  assert.equal(voice.speak('Rẽ phải', PRIORITY.turn), true);
  assert.equal(spoken.at(-1).voice, undefined);
  assert.equal(spoken.at(-1).lang, 'vi-VN');
});

// ---------- Trình duyệt quá cũ (js/compat.js) ----------

function runCompat({ noModule = true, booted = false } = {}) {
  const listeners = {};
  const line = { className: 'status-line', textContent: 'Đang tìm vị trí của bạn…' };
  const attrs = new Set(booted ? ['data-booted'] : []);
  const ctx = {
    window: { addEventListener: (t, fn) => (listeners[t] = fn) },
    document: {
      readyState: 'complete',
      documentElement: { hasAttribute: (a) => attrs.has(a) },
      getElementById: (id) => (id === 'gpsStatus' ? line : null),
      createElement: () => (noModule ? { noModule: false } : {}),
      addEventListener() {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/compat.js'), ctx);
  return { line, fire: (e) => listeners.error?.(e), boot: () => attrs.add('data-booted') };
}

test('js/compat.js: lỗi cú pháp khi nạp mã ứng dụng thì báo cần iOS 16.4; lỗi khác hay lỗi sau khi đã chạy thì không', () => {
  const a = runCompat();
  a.fire({ message: 'TypeError: x is undefined', error: { name: 'TypeError' } });
  assert.equal(a.line.textContent, 'Đang tìm vị trí của bạn…');
  a.fire({ message: 'SyntaxError: Invalid regular expression: invalid group specifier name', error: null });
  assert.match(a.line.textContent, /iOS 16\.4 trở lên/);
  assert.match(a.line.className, /\bwarn\b/);

  const b = runCompat();
  b.boot();
  b.fire({ message: 'SyntaxError: JSON Parse error', error: { name: 'SyntaxError' } });
  assert.equal(b.line.textContent, 'Đang tìm vị trí của bạn…');

  const c = runCompat({ noModule: false });
  assert.match(c.line.textContent, /chưa chạy được Bạn Đường/);
});

// ---------- Thẻ iOS trong index.html, biểu tượng ----------

test('index.html: thẻ cài như ứng dụng của iOS, viewport-fit=cover, biểu tượng 180×180, các phần tử gợi ý', () => {
  const html = read('index.html');
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Bạn Đường">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon.png">/);
  for (const id of ['iosHint', 'iosHintText', 'btnIosHint', 'btnIosHintClose', 'iosBox', 'iosNotes', 'btnIosSteps']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // Gợi ý và mục "Trên iPhone" ẩn sẵn: máy không phải iOS không bao giờ thấy.
  assert.match(html, /<div id="iosHint"[^>]* hidden>/);
  assert.match(html, /<div id="iosBox" hidden>/);
  // js/compat.js là script thường, chạy trước module của ứng dụng; không có script viết thẳng trong trang.
  assert.ok(html.indexOf('<script src="js/compat.js"></script>') < html.indexOf('<script type="module" src="js/main.js">'));
  assert.ok(!/<script>(?!<\/script>)/.test(html));

  const png = readFileSync(join(ROOT, 'icons/apple-touch-icon.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  assert.equal(png[25], 2, 'RGB không có kênh trong suốt: iOS tô đen chỗ trong suốt');
  assert.ok(png.length < 20000, 'biểu tượng nhỏ gọn');
});

test('css: vùng an toàn (tai thỏ, thanh home) cho các phần nổi, chống phóng to khi chạm ô nhập trên iOS', () => {
  const css = read('css/app.css');
  for (const sel of ['#top', '#sheet', '#side', '#speedo', '.panel', '.modal-card']) {
    const i = css.indexOf(`${sel} {`);
    assert.ok(i >= 0, sel);
    const block = css.slice(i, css.indexOf('}', i));
    assert.match(block, /env\(safe-area-inset-/, `${sel} chưa tránh vùng an toàn`);
  }
  assert.match(css, /@supports \(-webkit-touch-callout: none\)[^}]*font-size: max\(16px, 1em\)/);
  assert.match(css, /body::before \{[^}]*height: env\(safe-area-inset-top, 0px\)/);
});
