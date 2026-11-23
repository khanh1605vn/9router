// Thế giới cố định của bộ chạy thử lái xe (tests/browser/run.mjs): một đường thẳng hướng Đông có một nút giao, các biển
// đặt trên đó, dữ liệu Overpass giả lập đúng dạng js/roaddata.js đọc, và các phép đổi toạ độ dùng chung với scene.js
// (scene.js được chạy bằng vm để Node và trang dùng đúng một mô hình máy ảnh).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BROWSER_DIR = join(HERE, '..');

/** Mã nguồn các script chèn vào trang (đọc một lần). */
export const SOURCES = Object.freeze({
  scene: readFileSync(join(BROWSER_DIR, 'scene.js'), 'utf8'),
  oracle: readFileSync(join(BROWSER_DIR, 'oracle.js'), 'utf8'),
  init: readFileSync(join(BROWSER_DIR, 'init.js'), 'utf8'),
});

/** BDScene của scene.js, chạy trong một ngữ cảnh vm riêng. */
export const BDScene = (() => {
  const sandbox = { Math, Object, Number, String, Map, Array };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SOURCES.scene, sandbox, { filename: 'scene.js' });
  return sandbox.BDScene;
})();

// ---- Nơi đặt đường thử: giữa một ô dữ liệu 0,03° của roaddata.js (không chạm mép ô) ----
export const ORIGIN = Object.freeze({ lon0: 105.85, lat0: 21.014 });
export const WORLD = BDScene.makeWorld(ORIGIN);

// ---- Đường ----
export const ROAD = Object.freeze({
  from: -300, // m, đầu tây của đường thử
  to: 1500, // m, đầu đông
  step: 50, // m, khoảng cách giữa hai đỉnh
  junction: 700, // m, nút giao với đường ngang
  crossHalf: 450, // m, đường ngang dài chừng này mỗi phía nút giao
  westId: 1001, // đường chính phía tây nút giao
  eastId: 1002, // … phía đông
  crossId: 2001, // đường ngang (Bắc–Nam)
  maxspeed: 60, // km/h, giới hạn của bản đồ trên đường chính
  name: 'Đường Thử Nghiệm',
  crossName: 'Đường Ngang',
});

// Làn xe: đi Đông ở nửa nam (lệch +1,75 m so với tim), đi Tây ở nửa bắc.
export const LANE_EAST = BDScene.LANE_W / 2;
export const LANE_WEST = -BDScene.LANE_W / 2;
// Biển cho chiều đi Đông: 5 m bên phải làn xe.
export const SIGN_LAT = LANE_EAST + BDScene.SIGN_RIGHT;

/** Các biển của cảnh (chiều đi Đông). R.122 đặt 10 m trước nút giao, đúng chỗ bộ học neo biển của nút giao. */
export const SIGNS = Object.freeze({
  'P.127[50]': Object.freeze({ label: 'P.127[50]', code: 'P.127', value: '50', s: 350 }),
  'W.224': Object.freeze({ label: 'W.224', code: 'W.224', value: null, s: 520 }),
  'R.122': Object.freeze({ label: 'R.122', code: 'R.122', value: null, s: ROAD.junction - 10 }),
});

const r7 = (x) => Math.round(x * 1e7) / 1e7;
const ll = (c) => ({ lat: r7(c[1]), lon: r7(c[0]) });
/** Khoá đỉnh như vertexKey() của js/roaddata.js. */
export const vertexKey = (c) => `${r7(c[0]).toFixed(7)},${r7(c[1]).toFixed(7)}`;
export const JUNCTION_COORD = WORLD.toCoord(ROAD.junction, 0);
export const JUNCTION_KEY = vertexKey(JUNCTION_COORD);

function mainLine(s0, s1) {
  const pts = [];
  for (let s = s0; s <= s1 + 1e-9; s += ROAD.step) pts.push(ll(WORLD.toCoord(s, 0)));
  return pts;
}

/** Phản hồi Overpass (out tags geom) cho ô chứa đường thử. */
export function overpassFixture() {
  const j = JUNCTION_COORD;
  const dLat = 180 / (Math.PI * BDScene.EARTH);
  const cross = [];
  for (let d = -ROAD.crossHalf; d <= ROAD.crossHalf + 1e-9; d += ROAD.step) cross.push(ll([j[0], j[1] + d * dLat]));
  const main = { highway: 'secondary', name: ROAD.name, maxspeed: String(ROAD.maxspeed) };
  return {
    version: 0.6,
    generator: 'ban-duong tests/browser (dữ liệu giả lập)',
    osm3s: { timestamp_osm_base: '2026-11-20T00:00:00Z' },
    elements: [
      { type: 'way', id: ROAD.westId, tags: main, geometry: mainLine(ROAD.from, ROAD.junction) },
      { type: 'way', id: ROAD.eastId, tags: main, geometry: mainLine(ROAD.junction, ROAD.to) },
      { type: 'way', id: ROAD.crossId, tags: { highway: 'tertiary', name: ROAD.crossName }, geometry: cross },
    ],
  };
}

/** Khung [bbox:s,w,n,e] của một truy vấn Overpass (thân POST data=…), hoặc null. */
export function bboxOf(body) {
  let q = String(body || '');
  try {
    q = decodeURIComponent(q.replace(/^data=/, '').replace(/\+/g, ' '));
  } catch {
    return null;
  }
  const m = /\[bbox:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/.exec(q);
  return m ? { s: Number(m[1]), w: Number(m[2]), n: Number(m[3]), e: Number(m[4]) } : null;
}

/** Ô truy vấn có chứa đường thử không (các ô khác trả rỗng, để đường không bị lặp ở hai ô). */
export function bboxHasRoad(b) {
  return Boolean(b) && ORIGIN.lat0 >= b.s && ORIGIN.lat0 <= b.n && ORIGIN.lon0 >= b.w && ORIGIN.lon0 <= b.e;
}

/** Biển của cảnh cho trang: vị trí thế giới, chiều mặt biển, họ (từ labels.json). */
export function sceneSigns(labels, families) {
  return labels.map((l) => {
    const sg = SIGNS[l];
    if (!sg) throw new Error(`biển lạ: ${l}`);
    const fam = families[l] || 'ring';
    return { ...sg, lat: SIGN_LAT, dir: 1, shape: fam === 'triangle' || fam === 'invtriangle' ? 'triangle' : 'round' };
  });
}

/** Vị trí dọc đường (s, m) và lệch ngang (m) của một toạ độ. */
export const locate = (coord) => WORLD.fromCoord(coord);
