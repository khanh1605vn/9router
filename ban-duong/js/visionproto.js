// Lõi thuần của bộ nhận diện biển bằng camera, dùng chung cho trang (js/vision.js) và worker (js/vision-worker.js):
// kiểm tra mọi thông điệp giữa hai bên, hình học của hai lượt quét, giải mã đỉnh heatmap, NMS, khung cắt cho bộ
// phân loại, softmax có nhiệt độ, độ sáng khung hình. Không đụng tới DOM.
//
// Tệp này cố ý là một script "cổ điển" (không import/export): worker cổ điển nạp nó bằng importScripts (LiteRT.js cần
// worker cổ điển), còn trang và kiểm thử Node nạp nó bằng `import './visionproto.js'`. Cả hai cách đều chạy đúng một
// hàm bọc bên dưới, gắn kết quả vào biến toàn cục `VisionProto`. Vì phải hợp lệ ở cả hai dạng: không dùng `this` ở mức
// ngoài cùng, không dùng cú pháp chỉ có ở chế độ không nghiêm ngặt.

(function (root) {
  'use strict';

  // Hợp đồng mô hình (models/labels.json): đầu vào bộ dò 640×352, lưới đầu ra 80×44 (bước 8), 11 nhóm hình dạng;
  // bộ phân loại nhận ô 48×48.
  const DET_W = 640;
  const DET_H = 352;
  const STRIDE = 8;
  const GRID_W = DET_W / STRIDE;
  const GRID_H = DET_H / STRIDE;
  const FAMILIES = 11;
  const CLS_SIZE = 48;

  const SCORE_MIN = 0.3; // điểm đỉnh heatmap tối thiểu để thành một khung (PLAN §5.2)
  const NMS_IOU = 0.5; // hai khung chồng nhau quá mức này (IoU) thì bỏ khung điểm thấp hơn
  const MAX_BOXES = 12; // số khung tối đa mỗi khung hình, sau NMS
  const MAX_CANDIDATES = 64; // mỗi lượt quét chỉ giữ chừng này đỉnh điểm cao nhất trước NMS (giới hạn công việc)
  const MAX_BOX_SIDE = 2 * DET_W; // cạnh khung giải mã được (px đầu vào); exp(log) lớn hơn là đầu ra hỏng
  // Khung của lượt A cách một mép TRONG của ô cắt 640×352 (mép không trùng mép khung hình) dưới chừng này (px khung
  // gốc, một ô lưới) thì coi là bị ô cắt xén: biển đang ra khỏi ô nhưng vẫn trong khung hình, bề rộng sai. Bỏ khung đó.
  const CUT_MARGIN = STRIDE;
  const CLS_MIN_W = 20; // chỉ phân loại khung rộng từ chừng này (px của khung hình gốc)…
  const CLS_MAX_W = 400; // …đến chừng này
  const CLS_MAX = 8; // số khung phân loại tối đa mỗi khung hình
  const CROP_MARGIN = 0.15; // ô cắt cho bộ phân loại = khung + 15 % mỗi bên
  // Khung chồng lên một khung gợi ý (vị trí dự đoán của vệt đang theo dõi) từ mức IoU này thì được phân loại trước.
  const HINT_IOU = 0.05;
  const TOP_K = 3; // số nhãn trả về cho mỗi khung
  // Ảnh biển để kiểm tra độ chính xác (PLAN §6.5; chỉ khi người dùng bật camEval, mặc định tắt): mỗi khung đã phân loại
  // cho một ảnh PNG cắt sát: khung + EVAL_CROP_MARGIN mỗi bên, thu nhỏ (giữ tỉ lệ, không phóng to) để cạnh dài không quá
  // EVAL_CROP_MAX px. Ảnh lớn hơn EVAL_CROP_MAX_BYTES là lỗi (96×96 RGBA chưa nén mới chừng 36 KiB).
  const EVAL_CROP_MARGIN = CROP_MARGIN;
  const EVAL_CROP_MAX = 96;
  const EVAL_CROP_MAX_BYTES = 64 * 1024;
  const EVAL_CROP_TYPE = 'image/png';
  const T_MIN = 0.05; // nhiệt độ hiệu chỉnh hợp lệ (labels.json "T")
  const T_MAX = 20;
  const LUM_W = 64; // ảnh thu nhỏ để đo độ sáng (px)
  const LUM_H = 36;
  const FOE_Y = 0.42; // điểm tụ mặc định: giữa khung theo chiều ngang, 42 % chiều cao (PLAN §5.2)
  const MAX_FRAME_SIDE = 4096; // cạnh khung hình lớn nhất chấp nhận (px)
  const MAX_HINTS = 16;
  const MAX_ID = 2 ** 31 - 1;
  const MAX_FILE_BYTES = 32 * 1024 * 1024; // tệp mô hình hay wasm lớn hơn chừng này là sai
  const MAX_LABELS = 1000;
  const MAX_LABEL_LEN = 40;
  const MAX_BASE_LEN = 2048;
  const PASSES = ['A', 'B'];
  const BUILDS = ['compat', 'relaxed'];
  const ERROR_CODES = ['unsupported', 'integrity', 'load', 'worker'];
  const INIT_FILES = ['iife', 'loader', 'wasm', 'det', 'cls'];
  const HEX64 = /^[0-9a-f]{64}$/;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const bad = (reason) => ({ ok: false, reason });
  const OK = Object.freeze({ ok: true });
  const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

  // ---- Kiểm tra thông điệp --------------------------------------------------------------------------------------

  function isRect(r, lo, hi) {
    return isObj(r) && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h) &&
      r.w > 0 && r.h > 0 && r.w <= hi && r.h <= hi && r.x >= lo && r.y >= lo && r.x <= hi && r.y <= hi;
  }

  function isBuffer(b) {
    return typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer && b.byteLength > 0 && b.byteLength <= MAX_FILE_BYTES;
  }

  /** Thông điệp khởi tạo gửi vào worker: bản dựng đã chọn, các tệp đã kiểm SHA-256 (ArrayBuffer) và labels.json. */
  function checkInit(m) {
    if (!isObj(m) || m.type !== 'init') return bad('type');
    if (typeof m.base !== 'string' || !m.base || m.base.length > MAX_BASE_LEN || !/^https?:\/\//.test(m.base)) return bad('base');
    if (!BUILDS.includes(m.build)) return bad('build');
    if (!isObj(m.files) || !isObj(m.sha256)) return bad('files');
    for (const k of INIT_FILES) {
      if (!isBuffer(m.files[k])) return bad(`files.${k}`);
      if (typeof m.sha256[k] !== 'string' || !HEX64.test(m.sha256[k])) return bad(`sha256.${k}`);
    }
    const l = checkLabels(m.labels);
    if (!l.ok) return bad(`labels.${l.reason}`);
    return OK;
  }

  /** Một khung hình gửi vào worker. `bitmap` là ImageBitmap được chuyển quyền (transfer). */
  function checkFrame(m) {
    if (!isObj(m) || m.type !== 'frame') return bad('type');
    if (!isInt(m.id, 0, MAX_ID)) return bad('id');
    if (!isNum(m.t)) return bad('t');
    const b = m.bitmap;
    if (!b || typeof b !== 'object' || typeof b.close !== 'function') return bad('bitmap');
    if (!isInt(b.width, 1, MAX_FRAME_SIDE) || !isInt(b.height, 1, MAX_FRAME_SIDE)) return bad('bitmap.size');
    if (!Array.isArray(m.passes) || m.passes.length < 1 || m.passes.length > PASSES.length) return bad('passes');
    if (!m.passes.every((p) => PASSES.includes(p)) || new Set(m.passes).size !== m.passes.length) return bad('passes');
    const f = m.foe;
    if (!isObj(f) || !isNum(f.x) || !isNum(f.y) || f.x < 0 || f.y < 0 || f.x > b.width || f.y > b.height) return bad('foe');
    if (m.hints != null) {
      if (!Array.isArray(m.hints) || m.hints.length > MAX_HINTS) return bad('hints');
      if (!m.hints.every((h) => isRect(h, -MAX_FRAME_SIDE, 2 * MAX_FRAME_SIDE))) return bad('hints');
    }
    // Tuỳ chọn: true thì worker trả thêm ảnh cắt của từng khung đã phân loại (result.crops). Không có thì như cũ.
    if (m.evalCrops != null && typeof m.evalCrops !== 'boolean') return bad('evalCrops');
    return OK;
  }

  /** Số phần tử đầu vào của từng mô hình (lô 1). */
  const INPUT_SIZE = { det: DET_H * DET_W * 3, cls: CLS_SIZE * CLS_SIZE * 3 };

  /**
   * Chạy thẳng một tensor qua một mô hình (để so với vectơ mẫu khi kiểm thử): { type:'run', id, model:'det'|'cls',
   * input: Float32Array đúng kích thước đầu vào }.
   */
  function checkRun(m) {
    if (!isObj(m) || m.type !== 'run') return bad('type');
    if (!isInt(m.id, 0, MAX_ID)) return bad('id');
    if (!Object.hasOwn(INPUT_SIZE, m.model)) return bad('model');
    if (!(m.input instanceof Float32Array) || m.input.length !== INPUT_SIZE[m.model]) return bad('input');
    return OK;
  }

  /**
   * Thông điệp trang → worker. Kiểu lạ bị bỏ qua (ignore: true), không báo lỗi; kiểu quen mà trường sai thì báo lỗi.
   */
  function checkWorkerMessage(m) {
    if (!isObj(m)) return { ok: false, ignore: true, reason: 'type' };
    if (m.type === 'init') return checkInit(m);
    if (m.type === 'frame') return checkFrame(m);
    if (m.type === 'run') return checkRun(m);
    if (m.type === 'stats') return OK;
    return { ok: false, ignore: true, reason: 'type' };
  }

  function isBox(b) {
    if (!isObj(b) || !isNum(b.x) || !isNum(b.y) || !isNum(b.w) || !isNum(b.h) || !(b.w > 0) || !(b.h > 0)) return false;
    if (typeof b.family !== 'string' || !isNum(b.s) || b.s < 0 || b.s > 1 || !PASSES.includes(b.pass)) return false;
    if (b.cls === null) return true;
    return Array.isArray(b.cls) && b.cls.length >= 1 && b.cls.length <= TOP_K &&
      b.cls.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === 'string' && isNum(c[1]) && c[1] >= 0 && c[1] <= 1);
  }

  /** Blob PNG của một ảnh cắt (kiểm theo hình dạng: Blob của worker thuộc ngữ cảnh khác nên không dùng instanceof). */
  function isPngBlob(b) {
    return b !== null && typeof b === 'object' && typeof b.arrayBuffer === 'function' && b.type === EVAL_CROP_TYPE &&
      isInt(b.size, 1, EVAL_CROP_MAX_BYTES);
  }

  /**
   * result.crops (tuỳ chọn): [{ i, blob, w, h }], i là chỉ số một khung ĐÃ phân loại (cls khác null) trong boxes, mỗi
   * khung nhiều nhất một ảnh; blob là PNG; w, h là cỡ ảnh (px, 1…EVAL_CROP_MAX).
   */
  function isCrops(crops, boxes) {
    if (!Array.isArray(crops) || crops.length > CLS_MAX) return false;
    const seen = new Set();
    for (const c of crops) {
      if (!isObj(c) || !isInt(c.i, 0, boxes.length - 1) || seen.has(c.i) || boxes[c.i].cls === null) return false;
      if (!isInt(c.w, 1, EVAL_CROP_MAX) || !isInt(c.h, 1, EVAL_CROP_MAX) || !isPngBlob(c.blob)) return false;
      seen.add(c.i);
    }
    return true;
  }

  /** Thông điệp worker → trang. Kiểu lạ bị bỏ qua. */
  function checkResponse(m) {
    if (!isObj(m)) return { ok: false, ignore: true, reason: 'type' };
    switch (m.type) {
      case 'ready':
        if (!BUILDS.includes(m.build)) return bad('build');
        if (!sameList(m.input, [DET_W, DET_H])) return bad('input');
        if (!isInt(m.labels, 2, MAX_LABELS)) return bad('labels');
        return OK;
      case 'result': {
        if (!isInt(m.id, 0, MAX_ID) || !isNum(m.t)) return bad('id');
        const ms = m.ms;
        if (!isObj(ms) || !['pre', 'det', 'cls', 'total'].every((k) => isNum(ms[k]) && ms[k] >= 0)) return bad('ms');
        const l = m.lum;
        if (!isObj(l) || !isNum(l.mean) || !isNum(l.std) || l.mean < 0 || l.mean > 255 || l.std < 0 || l.std > 255) return bad('lum');
        if (!Array.isArray(m.boxes) || m.boxes.length > MAX_BOXES || !m.boxes.every(isBox)) return bad('boxes');
        if (m.crops != null && !isCrops(m.crops, m.boxes)) return bad('crops');
        return OK;
      }
      case 'error':
        if (!ERROR_CODES.includes(m.code)) return bad('code');
        if (m.id != null && !isInt(m.id, 0, MAX_ID)) return bad('id');
        return OK;
      case 'stats':
        if (!isInt(m.frames, 0, Number.MAX_SAFE_INTEGER) || !isInt(m.closed, 0, Number.MAX_SAFE_INTEGER)) return bad('stats');
        return OK;
      case 'outputs':
        if (!isInt(m.id, 0, MAX_ID)) return bad('id');
        if (!Array.isArray(m.outputs) || m.outputs.length < 1 || m.outputs.length > 2) return bad('outputs');
        for (const o of m.outputs) {
          if (!isObj(o) || !Array.isArray(o.shape) || !o.shape.every((d) => isInt(d, 1, MAX_FRAME_SIDE))) return bad('outputs');
          if (!(o.data instanceof Float32Array) || o.data.length !== o.shape.reduce((a, b) => a * b, 1)) return bad('outputs');
        }
        return OK;
      default:
        return { ok: false, ignore: true, reason: 'type' };
    }
  }

  /**
   * labels.json đúng hợp đồng chưa (phiên bản 1, đầu vào 640×352 bước 8, ô phân loại 48×48, nhiệt độ hợp lệ).
   * Trả { ok, reason, names, families, T }.
   */
  function checkLabels(j) {
    if (!isObj(j) || j.version !== 1) return bad('version');
    const fam = j.families;
    if (!Array.isArray(fam) || fam.length !== FAMILIES || new Set(fam).size !== FAMILIES) return bad('families');
    if (!fam.every((f) => typeof f === 'string' && f.length > 0 && f.length <= MAX_LABEL_LEN)) return bad('families');
    if (!isObj(j.det) || !sameList(j.det.input, [DET_H, DET_W, 3]) || j.det.stride !== STRIDE || !sameList(j.det.out, [GRID_H, GRID_W])) {
      return bad('det');
    }
    if (!isObj(j.cls) || !sameList(j.cls.input, [CLS_SIZE, CLS_SIZE, 3])) return bad('cls');
    if (!isNum(j.T) || j.T < T_MIN || j.T > T_MAX) return bad('T');
    const L = j.labels;
    if (!Array.isArray(L) || L.length < 2 || L.length > MAX_LABELS) return bad('labels');
    const names = [];
    for (let i = 0; i < L.length; i++) {
      const e = L[i];
      if (!isObj(e) || e.i !== i || typeof e.label !== 'string' || !e.label || e.label.length > MAX_LABEL_LEN) return bad('labels');
      if (e.family !== null && !fam.includes(e.family)) return bad('labels');
      names.push(e.label);
    }
    if (new Set(names).size !== names.length) return bad('labels');
    return { ok: true, reason: null, names, families: fam.slice(), T: j.T };
  }

  const shapeOf = (d) => (d && d.shape ? Array.from(d.shape) : null);

  /**
   * Kiểm tra vào/ra của hai mô hình (từ getInputDetails/getOutputDetails). Trả { ok, reason } — bộ dò phải có đúng
   * hai đầu ra phân biệt bằng số kênh (11: heat, 4: reg), bộ phân loại một đầu ra [1, số nhãn].
   */
  function checkModelIO(kind, inputs, outputs, nLabels) {
    if (!Array.isArray(inputs) || inputs.length !== 1 || !Array.isArray(outputs)) return bad('count');
    const f32 = (d) => d.dtype === 'float32';
    if (!inputs.every(f32) || !outputs.every(f32)) return bad('dtype');
    const inShape = shapeOf(inputs[0]);
    if (kind === 'det') {
      if (!sameList(inShape, [1, DET_H, DET_W, 3])) return bad('input');
      const shapes = outputs.map(shapeOf);
      if (shapes.length !== 2) return bad('outputs');
      const heat = shapes.findIndex((s) => sameList(s, [1, GRID_H, GRID_W, FAMILIES]));
      const reg = shapes.findIndex((s) => sameList(s, [1, GRID_H, GRID_W, 4]));
      if (heat < 0 || reg < 0) return bad('outputs');
      return OK;
    }
    if (kind === 'cls') {
      if (!sameList(inShape, [1, CLS_SIZE, CLS_SIZE, 3])) return bad('input');
      if (outputs.length !== 1 || !sameList(shapeOf(outputs[0]), [1, nLabels])) return bad('outputs');
      return OK;
    }
    return bad('kind');
  }

  // ---- Hình học hai lượt quét -----------------------------------------------------------------------------------

  /** Điểm tụ mặc định khi trang không gửi: giữa khung, 42 % chiều cao. */
  function defaultFoe(W, H) {
    return { x: W / 2, y: FOE_Y * H };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * Cách vẽ khung hình vào ô đầu vào 640×352 của bộ dò. Trả { src:[x,y,w,h] trên khung gốc, dst:[x,y,w,h] trên ô
   * đầu vào, cover: dst phủ kín ô hay không }.
   * - Lượt A: cắt 640×352 đúng độ phân giải gốc, tâm ở điểm tụ (dịch vào trong nếu chạm mép khung).
   * - Lượt B: cả khung thu nhỏ vừa ô 640×352, giữ tỉ lệ, phần thừa để đen (letterbox), căn giữa.
   */
  function passGeometry(pass, W, H, foe) {
    if (pass === 'A') {
      const w = Math.min(DET_W, W);
      const h = Math.min(DET_H, H);
      const f = foe || defaultFoe(W, H);
      const x = clamp(Math.round(f.x - w / 2), 0, W - w);
      const y = clamp(Math.round(f.y - h / 2), 0, H - h);
      return { src: [x, y, w, h], dst: [0, 0, w, h], cover: w === DET_W && h === DET_H };
    }
    const s = Math.min(DET_W / W, DET_H / H);
    const dw = clamp(Math.round(W * s), 1, DET_W);
    const dh = clamp(Math.round(H * s), 1, DET_H);
    const dx = Math.floor((DET_W - dw) / 2);
    const dy = Math.floor((DET_H - dh) / 2);
    return { src: [0, 0, W, H], dst: [dx, dy, dw, dh], cover: dw === DET_W && dh === DET_H };
  }

  /** Khung tính bằng px ô đầu vào (góc trên trái x, y) → px khung hình gốc, theo hình học của lượt quét. */
  function toFrame(box, g) {
    const kx = g.src[2] / g.dst[2];
    const ky = g.src[3] / g.dst[3];
    return {
      x: g.src[0] + (box.x - g.dst[0]) * kx,
      y: g.src[1] + (box.y - g.dst[1]) * ky,
      w: box.w * kx,
      h: box.h * ky,
    };
  }

  /**
   * Khung { x, y, w, h } (px khung gốc) có chạm một mép trong của ô quét g không (xem CUT_MARGIN). Mép của ô trùng mép
   * khung hình không tính: chạm mép khung hình là việc của bộ theo dõi (js/signtrack.js). Lượt B phủ cả khung hình nên
   * không bao giờ xén. Biển chỉ đi ra xa điểm tụ, nên khung bị xén là biển đang rời ô lượt A (từ ~24 m, PLAN §5.2):
   * lượt B, nếu chạy cùng khung, báo khung đầy đủ của nó.
   */
  function cutByCrop(box, g, W, H, margin) {
    const m = margin != null ? margin : CUT_MARGIN;
    const sx = g.src[0];
    const sy = g.src[1];
    const ex = sx + g.src[2];
    const ey = sy + g.src[3];
    return (sx > 0 && box.x <= sx + m) || (sy > 0 && box.y <= sy + m) ||
      (ex < W && box.x + box.w >= ex - m) || (ey < H && box.y + box.h >= ey - m);
  }

  // ---- Giải mã đầu ra bộ dò -------------------------------------------------------------------------------------

  /**
   * Đỉnh của heatmap (NHWC, [GRID_H, GRID_W, FAMILIES], đã qua sigmoid): ô có điểm ≥ SCORE_MIN và không nhỏ hơn 8 ô
   * kề cùng kênh (max-pool 3×3). Kích thước và vị trí lấy từ reg ([.., 4] = log_w, log_h, off_x, off_y).
   * Trả tối đa `max` khung { x, y, w, h (px ô đầu vào, góc trên trái), family (chỉ số kênh), s }, điểm giảm dần.
   */
  function decodePeaks(heat, reg, opts) {
    const o = opts || {};
    const gw = o.gw || GRID_W;
    const gh = o.gh || GRID_H;
    const nf = o.families || FAMILIES;
    const stride = o.stride || STRIDE;
    const min = o.min != null ? o.min : SCORE_MIN;
    const max = o.max != null ? o.max : MAX_CANDIDATES;
    const out = [];
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const base = (y * gw + x) * nf;
        for (let c = 0; c < nf; c++) {
          const v = heat[base + c];
          if (!(v >= min)) continue;
          let peak = true;
          for (let dy = -1; dy <= 1 && peak; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= gh) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if ((dx === 0 && dy === 0) || xx < 0 || xx >= gw) continue;
              if (heat[(yy * gw + xx) * nf + c] > v) {
                peak = false;
                break;
              }
            }
          }
          if (!peak) continue;
          const r = (y * gw + x) * 4;
          const w = Math.exp(reg[r]);
          const h = Math.exp(reg[r + 1]);
          const ox = clamp(reg[r + 2], 0, 1);
          const oy = clamp(reg[r + 3], 0, 1);
          if (!(w >= 1 && h >= 1 && w <= MAX_BOX_SIDE && h <= MAX_BOX_SIDE) || !Number.isFinite(ox + oy)) continue;
          const cx = (x + ox) * stride;
          const cy = (y + oy) * stride;
          out.push({ x: cx - w / 2, y: cy - h / 2, w, h, family: c, s: Math.min(1, v) });
        }
      }
    }
    out.sort((a, b) => b.s - a.s);
    if (out.length > max) out.length = max;
    return out;
  }

  /** Tỉ lệ giao trên hợp của hai khung { x, y, w, h }. */
  function iou(a, b) {
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ix <= 0 || iy <= 0) return 0;
    const inter = ix * iy;
    return inter / (a.w * a.h + b.w * b.h - inter);
  }

  /**
   * NMS tham lam không phân nhóm: lần lượt theo điểm giảm dần, bỏ khung chồng IoU > thr lên khung đã giữ.
   * Chạy chung cho cả hai lượt quét (cùng một biển thấy ở cả A và B chỉ còn một khung).
   */
  function nms(boxes, thr, max) {
    const t = thr != null ? thr : NMS_IOU;
    const cap = max != null ? max : MAX_BOXES;
    const sorted = boxes.slice().sort((a, b) => b.s - a.s);
    const keep = [];
    for (const b of sorted) {
      if (keep.length >= cap) break;
      if (keep.every((k) => iou(k, b) <= t)) keep.push(b);
    }
    return keep;
  }

  // ---- Bộ phân loại -------------------------------------------------------------------------------------------

  /**
   * Chọn khung để phân loại: rộng CLS_MIN_W–CLS_MAX_W px (khung gốc), tối đa CLS_MAX; khung chồng lên một khung gợi ý
   * (IoU ≥ HINT_IOU) được ưu tiên, sau đó theo điểm. Trả danh sách chỉ số trong `boxes`.
   */
  function pickForClassifier(boxes, hints, opts) {
    const o = opts || {};
    const minW = o.minW != null ? o.minW : CLS_MIN_W;
    const maxW = o.maxW != null ? o.maxW : CLS_MAX_W;
    const cap = o.max != null ? o.max : CLS_MAX;
    const hs = Array.isArray(hints) ? hints : [];
    const cand = [];
    boxes.forEach((b, i) => {
      if (!(b.w >= minW && b.w <= maxW)) return;
      const hinted = hs.some((h) => iou(h, b) >= HINT_IOU);
      cand.push({ i, hinted, s: b.s });
    });
    cand.sort((a, b) => (a.hinted !== b.hinted ? (a.hinted ? -1 : 1) : b.s - a.s || a.i - b.i));
    return cand.slice(0, cap).map((c) => c.i);
  }

  /**
   * Ô cắt cho bộ phân loại: khung + CROP_MARGIN mỗi bên, kéo giãn thành size×size. Phần nằm ngoài khung hình bị cắt
   * bỏ (để đen) theo đúng tỉ lệ. Trả { src:[x,y,w,h], dst:[x,y,w,h] } hoặc null nếu ô nằm hẳn ngoài khung hình.
   */
  function cropRect(box, W, H, margin, size) {
    const m = margin != null ? margin : CROP_MARGIN;
    const S = size || CLS_SIZE;
    const rx = box.x - m * box.w;
    const ry = box.y - m * box.h;
    const rw = box.w * (1 + 2 * m);
    const rh = box.h * (1 + 2 * m);
    const x0 = Math.max(0, rx);
    const y0 = Math.max(0, ry);
    const x1 = Math.min(W, rx + rw);
    const y1 = Math.min(H, ry + rh);
    if (!(x1 > x0 && y1 > y0)) return null;
    return {
      src: [x0, y0, x1 - x0, y1 - y0],
      dst: [((x0 - rx) / rw) * S, ((y0 - ry) / rh) * S, ((x1 - x0) / rw) * S, ((y1 - y0) / rh) * S],
    };
  }

  /**
   * Ảnh cắt để kiểm tra độ chính xác: khung + margin mỗi bên, chỉ phần nằm trong khung hình (không độn đen), thu nhỏ
   * giữ tỉ lệ để cạnh dài không quá max px (không phóng to). Trả { src:[x,y,w,h] trên khung gốc, w, h (px nguyên của
   * ảnh) } hoặc null nếu vùng cắt nằm hẳn ngoài khung hình.
   */
  function evalCropRect(box, W, H, margin, max) {
    const m = margin != null ? margin : EVAL_CROP_MARGIN;
    const M = max || EVAL_CROP_MAX;
    const x0 = Math.max(0, box.x - m * box.w);
    const y0 = Math.max(0, box.y - m * box.h);
    const x1 = Math.min(W, box.x + box.w * (1 + m));
    const y1 = Math.min(H, box.y + box.h * (1 + m));
    if (!(x1 > x0 && y1 > y0)) return null;
    const sw = x1 - x0;
    const sh = y1 - y0;
    const k = Math.min(1, M / Math.max(sw, sh));
    return { src: [x0, y0, sw, sh], w: clamp(Math.round(sw * k), 1, M), h: clamp(Math.round(sh * k), 1, M) };
  }

  /** softmax(logits / T), ổn định số học. */
  function softmaxT(logits, T) {
    const t = T > 0 ? T : 1;
    const n = logits.length;
    const out = new Float64Array(n);
    let mx = -Infinity;
    for (let i = 0; i < n; i++) if (logits[i] > mx) mx = logits[i];
    if (!Number.isFinite(mx)) return out.fill(1 / n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const e = Math.exp((logits[i] - mx) / t);
      out[i] = e;
      sum += e;
    }
    for (let i = 0; i < n; i++) out[i] /= sum;
    return out;
  }

  /** k nhãn xác suất cao nhất: [[nhãn, p], …], p giảm dần; bằng nhau thì nhãn đứng trước trong labels.json trước. */
  function topK(probs, names, k) {
    const K = Math.min(k || TOP_K, probs.length);
    const best = [];
    for (let i = 0; i < probs.length; i++) {
      const p = probs[i];
      if (best.length === K && p <= probs[best[K - 1]]) continue;
      let j = best.length < K ? best.length : K - 1;
      best[j] = i;
      while (j > 0 && probs[best[j - 1]] < p) {
        best[j] = best[j - 1];
        best[j - 1] = i;
        j--;
      }
    }
    return best.map((i) => [names[i], probs[i]]);
  }

  // ---- Điểm ảnh ---------------------------------------------------------------------------------------------------

  /** RGBA 8 bit (ImageData.data) → RGB float [0,1] vào `out` (dùng lại mảng, không cấp phát). */
  const INV255 = new Float32Array(256);
  for (let i = 0; i < 256; i++) INV255[i] = i / 255;
  function rgbaToRgb(rgba, out) {
    const n = Math.min(rgba.length >> 2, Math.floor(out.length / 3));
    for (let p = 0, j = 0, q = 0; p < n; p++, q += 4) {
      out[j++] = INV255[rgba[q]];
      out[j++] = INV255[rgba[q + 1]];
      out[j++] = INV255[rgba[q + 2]];
    }
    return out;
  }

  /** Độ sáng trung bình và độ lệch chuẩn (thang 0–255, luma BT.601) của ảnh RGBA thu nhỏ. */
  function lumStats(rgba) {
    const n = rgba.length >> 2;
    if (!n) return { mean: 0, std: 0 };
    let s = 0;
    let s2 = 0;
    for (let q = 0; q < rgba.length; q += 4) {
      const y = 0.299 * rgba[q] + 0.587 * rgba[q + 1] + 0.114 * rgba[q + 2];
      s += y;
      s2 += y * y;
    }
    const mean = s / n;
    return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
  }

  root.VisionProto = Object.freeze({
    DET_W, DET_H, STRIDE, GRID_W, GRID_H, FAMILIES, CLS_SIZE,
    SCORE_MIN, NMS_IOU, MAX_BOXES, MAX_CANDIDATES, MAX_BOX_SIDE, CUT_MARGIN, CLS_MIN_W, CLS_MAX_W, CLS_MAX, CROP_MARGIN, HINT_IOU,
    TOP_K, T_MIN, T_MAX, LUM_W, LUM_H, FOE_Y, MAX_FRAME_SIDE, MAX_HINTS, MAX_ID, MAX_FILE_BYTES, MAX_LABELS,
    EVAL_CROP_MARGIN, EVAL_CROP_MAX, EVAL_CROP_MAX_BYTES, EVAL_CROP_TYPE,
    PASSES, BUILDS, ERROR_CODES, INIT_FILES,
    INPUT_SIZE,
    checkInit, checkFrame, checkRun, checkWorkerMessage, checkResponse, checkLabels, checkModelIO,
    defaultFoe, passGeometry, toFrame, cutByCrop, decodePeaks, iou, nms, pickForClassifier, cropRect, evalCropRect, softmaxT,
    topK,
    rgbaToRgb, lumStats,
  });
})(typeof self !== 'undefined' ? self : globalThis);
