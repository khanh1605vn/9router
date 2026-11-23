// Bộ nhận diện "biết trước" (oracle) cho bộ chạy thử lái xe (tests/browser/run.mjs), dùng khi chưa có mô hình đã huấn
// luyện. Script thường, chèn vào trang sau scene.js; chỉ đặt globalThis.BDOracle.
//
// Nó thay Vision qua móc kiểm thử globalThis.__BD_TEST__.visionFactory của js/camctl.js: nhận đúng khung hình camera
// (ImageBitmap từ canvas của cảnh), đo độ sáng thật của khung, rồi chiếu các biển đã biết của cảnh qua CÙNG mô hình
// máy ảnh (scene.js) thành hộp như hợp đồng 5, có nhiễu như bộ nhận diện thật: rung hộp, khung bỏ sót, ngưỡng 10 px
// của bộ dò, lượt A chỉ thấy trong ô cắt 640×352 quanh điểm tụ, lượt B thấy cả khung thu nhỏ 3 lần, bộ phân loại chỉ
// chạy cho hộp rộng 20–400 px với p từ 0,8 đến 0,99. Mọi phần sau đó (bám biển, đo khoảng cách, đặt biển, kho,
// xác nhận, cảnh báo, câu đọc, biển giới hạn, CameraLimit) là mã thật của ứng dụng.
// Không thấy gì: khung đen (lum), ban đêm (giả định xấu nhất: bộ dò mù), mặt sau của biển, biển bị xe tải che.

(function (root) {
  'use strict';

  const S = root.BDScene;
  const DET_W = 640; // px, ô cắt của lượt A (như VisionProto.DET_W)
  const DET_H = 352;
  const CUT_MARGIN = 8; // px, hộp sát mép trong của ô cắt lượt A bị bỏ (như VisionProto.CUT_MARGIN)
  const B_SCALE = 3; // lượt B: cả khung thu nhỏ chừng này lần
  const DET_MIN_PX = 10; // px của đầu vào bộ dò: hộp nhỏ hơn thì không thấy
  const P_DETECT = 0.95; // xác suất thấy một biển trong một lượt quét, trời sáng
  const P_DETECT_RAIN = 0.85; // … khi mưa
  const BOX_NOISE_REL = 0.03; // rung cỡ hộp: độ lệch chuẩn tương đối
  const BOX_NOISE_PX = 0.7; // … cộng thêm (px)
  const CENTRE_NOISE_PX = 1; // rung tâm hộp (px, độ lệch chuẩn)
  const CLS_MIN_W = 20; // px, bộ phân loại chỉ chạy cho hộp từ chừng này (như VisionProto.CLS_MIN_W)…
  const CLS_MAX_W = 400; // … tới chừng này
  const CLS_CAP = 8; // hộp được phân loại tối đa mỗi khung (như VisionProto.CLS_MAX)
  const P_CLS_MIN = 0.8; // p của nhãn đúng (đã hiệu chỉnh), phân bố đều trong khoảng này
  const P_CLS_MAX = 0.99;
  const P_CONFUSE = 0.02; // xác suất bộ phân loại đọc nhầm sang nhãn gần giống trong một khung
  const OCCLUDE_MIN = 0.4; // phần hộp biển bị xe tải che từ chừng này trở lên thì không thấy
  const MAX_BOXES = 12; // như VisionProto.MAX_BOXES
  const MS_PRE = 3; // ms báo về cho bộ chọn mức tải: chuẩn bị khung
  const MS_DET = 15; // … bộ dò, mỗi lượt quét
  const MS_CLS = 1.5; // … mỗi hộp được phân loại
  const MS_JITTER = 2; // … dao động (ms)
  const LUM_W = 64; // ảnh thu nhỏ để đo độ sáng (như VisionProto.LUM_W)
  const LUM_H = 36;
  const MAX_GAPS = 2000; // số khoảng cách giữa hai khung liên tiếp được ghi lại (ms)

  /** Tỉ lệ hộp so với cỡ biển theo họ biển (tam giác thấp hơn bề rộng). */
  const SHAPE = Object.freeze({
    triangle: { bw: 0.94, bh: 0.82 },
    invtriangle: { bw: 0.94, bh: 0.82 },
    default: { bw: 0.96, bh: 0.96 },
  });

  /** Nhãn dễ nhầm với một nhãn (cho khung đọc nhầm và nhãn thứ hai, thứ ba của top-3). */
  function confusable(label) {
    const m = /^P\.127\[(\d+)\]$/.exec(label);
    if (m) return [`P.127[${Number(m[1]) === 50 ? 60 : 50}]`, 'P.127[40]'];
    if (label === 'R.122') return ['P.102', 'other-sign'];
    return ['other-sign', 'background'];
  }

  /** Độ sáng (thang 0–255, luma BT.601) của khung thật, như VisionProto.lumStats trên ảnh 64×36. */
  function lumOf(bitmap, small) {
    const g = small.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, LUM_W, LUM_H);
    const d = g.getImageData(0, 0, LUM_W, LUM_H).data;
    let s = 0;
    let s2 = 0;
    const n = d.length >> 2;
    for (let q = 0; q < d.length; q += 4) {
      const y = 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
      s += y;
      s2 += y * y;
    }
    const mean = s / n;
    return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
  }

  /** Hộp nằm gọn trong ô cắt lượt A (mép trong của ô có lề CUT_MARGIN). */
  function insideA(b, crop, W, H) {
    const l = crop.x > 0 ? CUT_MARGIN : 0;
    const t = crop.y > 0 ? CUT_MARGIN : 0;
    const r = crop.x + DET_W < W ? CUT_MARGIN : 0;
    const d = crop.y + DET_H < H ? CUT_MARGIN : 0;
    return b.x >= crop.x + l && b.y >= crop.y + t && b.x + b.w <= crop.x + DET_W - r && b.y + b.h <= crop.y + DET_H - d;
  }

  /**
   * Nhà máy Vision giả. getScene() → { signs, flags }, getPose(t) → tư thế xe lúc t (performance.now()),
   * families: { label → họ }, seed, stats: đối tượng ghi số liệu (tuỳ chọn).
   */
  function createFactory({ getScene, getPose, families, seed = 1, stats = {} }) {
    const r = S.rng(seed);
    Object.assign(stats, { frames: 0, boxes: 0, classified: 0, byPass: { A: 0, B: 0 }, perSign: {}, lum: null, gaps: [] });
    let lastT = null;
    return function factory() {
      let small = null;
      return {
        ready: false,
        level: 2,
        load() {
          this.ready = true;
          return Promise.resolve({ build: 'oracle' });
        },
        terminate() {
          this.ready = false;
        },
        stats() {
          return { ...stats };
        },
        async process(frame, { passes = ['A'], foe = null } = {}) {
          const bmp = frame.bitmap;
          if (lastT != null && stats.gaps.length < MAX_GAPS) stats.gaps.push(Math.round(frame.t - lastT));
          lastT = frame.t;
          const W = bmp.width;
          const H = bmp.height;
          small = small || new OffscreenCanvas(LUM_W, LUM_H);
          const lum = lumOf(bmp, small);
          try {
            bmp.close(); // như worker: mọi khung đều được đóng
          } catch {
            // đã đóng
          }
          const scene = getScene();
          const flags = scene.flags || {};
          const pose = getPose(frame.t);
          const cam = S.camera(pose, { width: W, height: H });
          const f = foe || { x: cam.cx, y: cam.cy };
          const crop = { x: Math.max(0, Math.min(W - DET_W, Math.round(f.x - DET_W / 2))), y: Math.max(0, Math.min(H - DET_H, Math.round(f.y - DET_H / 2))) };
          const blind = flags.blank || flags.night;
          const pDet = flags.rain ? P_DETECT_RAIN : P_DETECT;
          const truck = flags.truck ? S.truckBox(cam, pose, flags.truck) : null;
          const out = [];
          for (const sg of blind ? [] : scene.signs) {
            if ((sg.dir >= 0 ? 1 : -1) !== cam.dir) continue; // mặt sau của biển
            const fam = families[sg.label] || 'ring';
            const b = S.signBox(cam, sg, SHAPE[fam] || SHAPE.default);
            if (!b || b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) continue;
            if (truck && truck.Z < b.Z && S.overlapShare(b, truck) >= OCCLUDE_MIN) continue;
            const inA = passes.includes('A') && insideA(b, crop, W, H) && Math.min(b.w, b.h) >= DET_MIN_PX;
            const inB = passes.includes('B') && Math.min(b.w, b.h) / B_SCALE >= DET_MIN_PX;
            if (!inA && !inB) continue;
            if (r() > pDet) continue; // khung bỏ sót
            const k = 1 + BOX_NOISE_REL * r.gauss();
            const w = Math.max(2, b.w * k + BOX_NOISE_PX * r.gauss());
            const h = Math.max(2, b.h * k + BOX_NOISE_PX * r.gauss());
            const cx = b.u + CENTRE_NOISE_PX * r.gauss();
            const cy = b.v + CENTRE_NOISE_PX * r.gauss();
            out.push({ sg, fam, pass: inA ? 'A' : 'B', box: { x: cx - w / 2, y: cy - h / 2, w, h }, s: 0.55 + 0.4 * r(), Z: b.Z });
          }
          out.sort((a, b) => b.s - a.s);
          let ncls = 0;
          const boxes = out.slice(0, MAX_BOXES).map((o) => {
            let cls = null;
            if (o.box.w >= CLS_MIN_W && o.box.w <= CLS_MAX_W && ncls < CLS_CAP) {
              ncls++;
              const [c1, c2] = confusable(o.sg.label);
              const p1 = r.range(P_CLS_MIN, P_CLS_MAX);
              const p2 = (1 - p1) * r.range(0.5, 0.8);
              const p3 = Math.max(0, 1 - p1 - p2) * 0.5;
              cls = r() < P_CONFUSE ? [[c1, p1], [o.sg.label, p2], [c2, p3]] : [[o.sg.label, p1], [c1, p2], [c2, p3]];
            }
            const ps = (stats.perSign[o.sg.label] ||= { boxes: 0, classified: 0, minZ: Infinity, maxZ: 0 });
            ps.boxes++;
            if (cls) ps.classified++;
            ps.minZ = Math.min(ps.minZ, Math.round(o.Z * 10) / 10);
            ps.maxZ = Math.max(ps.maxZ, Math.round(o.Z * 10) / 10);
            stats.byPass[o.pass]++;
            return { ...o.box, family: o.fam, s: o.s, pass: o.pass, cls };
          });
          stats.frames++;
          stats.boxes += boxes.length;
          stats.classified += ncls;
          stats.lum = { mean: Math.round(lum.mean), std: Math.round(lum.std) };
          const det = MS_DET * passes.length + MS_JITTER * r();
          const cls = MS_CLS * ncls;
          const ms = { pre: MS_PRE, det, cls, total: MS_PRE + det + cls };
          await new Promise((done) => setTimeout(done, ms.total)); // một khung đang xử lý, như worker thật
          return { t: frame.t, ms, lum, boxes };
        },
      };
    };
  }

  root.BDOracle = Object.freeze({
    DET_W, DET_H, CUT_MARGIN, B_SCALE, DET_MIN_PX, P_DETECT, P_DETECT_RAIN, BOX_NOISE_REL, BOX_NOISE_PX, CENTRE_NOISE_PX,
    CLS_MIN_W, CLS_MAX_W, CLS_CAP, P_CLS_MIN, P_CLS_MAX, P_CONFUSE, OCCLUDE_MIN, MAX_BOXES, SHAPE,
    confusable, insideA, createFactory,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
