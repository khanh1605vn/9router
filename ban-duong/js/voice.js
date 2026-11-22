// Giọng đọc tiếng Việt (Web Speech API) và âm báo (Web Audio).
// Trình duyệt chỉ cho phát âm thanh sau khi người dùng chạm vào màn hình, nên cần gọi unlock()
// trong một sự kiện chạm/bấm.

const ABBREVIATIONS = [
  [/\bQL\.?\s?(?=\d)/g, 'Quốc lộ '],
  [/\bTL\.?\s?(?=\d)/g, 'Tỉnh lộ '],
  [/(^|[\s,])(?:ĐT|DT)\.?\s?(?=\d)/g, '$1Đường tỉnh '],
  [/(^|[\s,])ĐH\.?\s?(?=\d)/g, '$1Đường huyện '],
  [/\bHL\.?\s?(?=\d)/g, 'Hương lộ '],
  [/\bCT\.?\s?(?=\d)/g, 'Cao tốc '],
  // Không dùng \b sau đơn vị: JS coi chữ có dấu (é, ô…) là ký tự "không phải chữ".
  [/km\/h(?=[\s,.;!?)]|$)/g, 'ki lô mét trên giờ'],
  [/(\d)\s?km(?=[\s,.;!?)]|$)/g, '$1 ki lô mét'],
  [/(\d)\s?m(?=[\s,.;!?)]|$)/g, '$1 mét'],
];

/** Viết lại chữ tắt để máy đọc cho tự nhiên. */
export function normalizeForSpeech(text) {
  let out = text;
  for (const [re, to] of ABBREVIATIONS) out = out.replace(re, to);
  return out;
}

// Mức ưu tiên: chỉ dẫn rẽ > cảnh báo > thông tin.
export const PRIORITY = { info: 0, alert: 1, turn: 2 };

class Voice {
  constructor() {
    this.enabled = true;
    this.beeps = true;
    this.ctx = null;
    this.voice = null;
    this.currentPriority = -1;
    this.primed = false;
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    if (this.supported) {
      this.#pickVoice();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.#pickVoice());
    }
  }

  #pickVoice() {
    const voices = window.speechSynthesis.getVoices() || [];
    const vi = voices.filter((v) => /^vi([-_]|$)/i.test(v.lang));
    this.voice = vi.find((v) => v.localService) || vi[0] || null;
  }

  /** Thiết bị có giọng đọc tiếng Việt hay không (null = chưa xác định được). */
  get hasVietnamese() {
    if (!this.supported) return false;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    return Boolean(this.voice);
  }

  /** Gọi trong sự kiện chạm đầu tiên để mở khoá âm thanh. */
  unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !this.ctx) this.ctx = new AC();
      if (this.ctx?.state === 'suspended') this.ctx.resume();
    } catch {
      /* không có Web Audio: bỏ qua âm báo */
    }
    // iOS chỉ cho đọc sau khi đã có một câu được phát trong lúc người dùng chạm: phát một câu im lặng.
    if (this.supported && !this.primed) {
      this.primed = true;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      } catch {
        /* bỏ qua */
      }
    }
  }

  /**
   * Đọc một câu. Câu ưu tiên cao hơn sẽ ngắt câu đang đọc; câu cùng mức hoặc cảnh báo thì xếp hàng
   * đọc tiếp ngay sau; thông tin phụ bị bỏ qua nếu máy đang bận.
   */
  speak(text, priority = PRIORITY.info) {
    if (!this.enabled || !this.supported || !text) return false;
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) {
      if (priority > this.currentPriority) synth.cancel();
      else if (priority === PRIORITY.info) return false;
    }
    const u = new SpeechSynthesisUtterance(normalizeForSpeech(text));
    u.lang = 'vi-VN';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    u.onend = u.onerror = () => {
      if (!synth.speaking && !synth.pending) this.currentPriority = -1;
    };
    this.currentPriority = Math.max(this.currentPriority, priority);
    synth.speak(u);
    return true;
  }

  stop() {
    if (this.supported) window.speechSynthesis.cancel();
    this.currentPriority = -1;
  }

  #tone(freq, start, length, gain = 0.2) {
    const t0 = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.001, t0 + length);
    osc.connect(amp).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + length + 0.02);
  }

  /** Âm báo: 'alert' (điểm cảnh báo), 'over' (quá tốc độ), 'turn' (sắp rẽ), 'done' (xác nhận). */
  chime(kind) {
    if (!this.beeps || !this.ctx || this.ctx.state !== 'running') return;
    try {
      if (kind === 'alert') {
        this.#tone(880, 0, 0.16);
        this.#tone(1175, 0.18, 0.24);
      } else if (kind === 'over') {
        this.#tone(1320, 0, 0.09, 0.25);
        this.#tone(1320, 0.14, 0.09, 0.25);
        this.#tone(1320, 0.28, 0.09, 0.25);
      } else if (kind === 'turn') {
        this.#tone(660, 0, 0.14);
      } else {
        this.#tone(784, 0, 0.12);
        this.#tone(1047, 0.13, 0.2);
      }
    } catch {
      /* bỏ qua */
    }
  }
}

export const voice = new Voice();
