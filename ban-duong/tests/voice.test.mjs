import test from 'node:test';
import assert from 'node:assert/strict';

// Giả lập Web Speech API: câu được đọc lần lượt; cancel() huỷ mọi câu và báo lỗi 'interrupted' (bất đồng bộ như Chrome).
const synth = {
  queue: [],
  log: [],
  get speaking() {
    return this.queue.length > 0;
  },
  get pending() {
    return this.queue.length > 1;
  },
  speak(u) {
    this.queue.push(u);
  },
  cancel() {
    const dropped = this.queue;
    this.queue = [];
    if (dropped.length) this.log.push(`huỷ: ${dropped.map((u) => u.text).join(' | ')}`);
    for (const u of dropped) queueMicrotask(() => u.onerror?.({ error: 'interrupted' }));
  },
  /** Đọc xong câu đang đọc. */
  finish() {
    const u = this.queue.shift();
    if (!u) return null;
    this.log.push(`đọc: ${u.text}`);
    u.onend?.({});
    return u.text;
  },
  getVoices: () => [],
  addEventListener() {},
};
globalThis.window = { speechSynthesis: synth };
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
  }
};
const { PRIORITY, voice } = await import('../js/voice.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function reset() {
  voice.stop();
  synth.queue = [];
  synth.log = [];
  voice.enabled = true;
}

/** Đọc hết hàng chờ, trả về thứ tự các câu đã đọc. */
function drain() {
  const out = [];
  for (let t = synth.finish(); t != null; t = synth.finish()) out.push(t);
  return out;
}

const SIGN = 'Phía trước 100 mét, cấm rẽ trái';
const MID = 'Còn 200 mét, rẽ phải vào Lê Lợi';

test('câu rẽ "Còn … mét" tới khi đang đọc câu cảnh báo biển: xếp hàng sau, không cắt mất câu cảnh báo', async () => {
  reset();
  voice.speak(SIGN, PRIORITY.alert);
  voice.speak(MID, PRIORITY.turn);
  await flush();
  assert.equal(synth.log.length, 0, 'không câu nào bị huỷ');
  assert.deepEqual(drain(), [SIGN, MID]);
});

test('câu rẽ ngay (gấp) ngắt câu cảnh báo, rồi câu cảnh báo được đọc lại ngay sau', async () => {
  reset();
  voice.speak(SIGN, PRIORITY.alert);
  voice.speak('Rẽ phải vào Lê Lợi', PRIORITY.turn, { urgent: true });
  await flush(); // lỗi 'interrupted' của câu bị huỷ tới sau: không được xoá nhầm câu đọc lại
  assert.deepEqual(synth.log, [`huỷ: ${SIGN}`]);
  assert.equal(voice.queue.length, 2);
  assert.equal(voice.currentPriority, PRIORITY.turn);
  assert.deepEqual(drain(), ['Rẽ phải vào Lê Lợi', SIGN]);
  assert.equal(voice.currentPriority, -1);
});

test('câu cảnh báo đã chờ quá 5 giây (khoảng cách trong câu đã cũ) thì không đọc lại sau câu rẽ gấp', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  voice.speak(SIGN, PRIORITY.alert);
  t.mock.timers.tick(6000);
  voice.speak('Rẽ phải', PRIORITY.turn, { urgent: true });
  t.mock.timers.reset();
  await flush();
  assert.deepEqual(drain(), ['Rẽ phải']);
});

test('câu rẽ gấp tới khi đang đọc câu gấp khác: xếp hàng, không huỷ', async () => {
  reset();
  voice.speak('Rẽ phải', PRIORITY.turn, { urgent: true });
  voice.speak('Rẽ trái', PRIORITY.turn, { urgent: true });
  await flush();
  assert.equal(synth.log.length, 0);
  assert.deepEqual(drain(), ['Rẽ phải', 'Rẽ trái']);
});

test('thông tin phụ: bị bỏ khi máy đang bận, và bị câu cảnh báo hay câu rẽ ngắt như trước', async () => {
  reset();
  assert.equal(voice.speak('Giới hạn tốc độ 50 ki lô mét trên giờ', PRIORITY.info), true);
  voice.speak(SIGN, PRIORITY.alert);
  await flush();
  assert.deepEqual(synth.log, ['huỷ: Giới hạn tốc độ 50 ki lô mét trên giờ']);
  assert.equal(voice.speak('Giới hạn tốc độ 60 ki lô mét trên giờ', PRIORITY.info), false);
  assert.deepEqual(drain(), [SIGN]);

  reset();
  voice.speak('Giới hạn tốc độ 50 ki lô mét trên giờ', PRIORITY.info);
  voice.speak(MID, PRIORITY.turn);
  await flush();
  assert.deepEqual(drain(), [MID]);
});

test('hai câu cảnh báo liền nhau (camera rồi biển báo) xếp hàng đọc lần lượt', async () => {
  reset();
  voice.speak('Còn 300 mét, có camera bắn tốc độ', PRIORITY.alert);
  voice.speak(SIGN, PRIORITY.alert);
  await flush();
  assert.deepEqual(drain(), ['Còn 300 mét, có camera bắn tốc độ', SIGN]);
});

test('stop() huỷ hết và quên hàng chờ', async () => {
  reset();
  voice.speak(SIGN, PRIORITY.alert);
  voice.speak(MID, PRIORITY.turn);
  voice.stop();
  await flush();
  assert.equal(voice.queue.length, 0);
  assert.equal(voice.currentPriority, -1);
  assert.equal(synth.queue.length, 0);
});
