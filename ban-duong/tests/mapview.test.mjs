import test from 'node:test';
import assert from 'node:assert/strict';
import { MapView, TILEJSON_CHECK, tileTemplatesDiffer } from '../js/mapview.js';

// Bản đồ nền OpenFreeMap dựng lại khoảng mỗi tuần: ứng dụng mở liền nhiều ngày vẫn chuyển sang bản dựng mới.

const OLD = ['https://tiles.openfreemap.org/planet/20261111_001001_pt/{z}/{x}/{y}.pbf'];
const NEW = ['https://tiles.openfreemap.org/planet/20261118_001001_pt/{z}/{x}/{y}.pbf'];
const TJ = 'https://tiles.openfreemap.org/planet';

test('tileTemplatesDiffer: chỉ tin mảng địa chỉ https không rỗng, khác bản đang dùng', () => {
  assert.equal(tileTemplatesDiffer(OLD, NEW), true);
  assert.equal(tileTemplatesDiffer(OLD, [...OLD]), false);
  assert.equal(tileTemplatesDiffer(undefined, NEW), true);
  assert.equal(tileTemplatesDiffer(OLD, []), false);
  assert.equal(tileTemplatesDiffer(OLD, null), false);
  assert.equal(tileTemplatesDiffer(OLD, ['http://tiles.openfreemap.org/x/{z}/{x}/{y}.pbf']), false);
  assert.equal(tileTemplatesDiffer(OLD, [42]), false);
  assert.ok(TILEJSON_CHECK >= 3600e3, 'không hỏi TileJSON dày hơn mỗi giờ');
});

/** MapView với bản đồ MapLibre giả: một nguồn vector theo TileJSON, một nguồn GeoJSON của ứng dụng. */
function fakeView(tiles) {
  const view = new MapView(null);
  const src = { tiles, setUrl: (u) => src.reloads.push(u), reloads: [] };
  view.map = {
    getStyle: () => ({ sources: { openmaptiles: { type: 'vector', url: TJ }, 'bd-route': { type: 'geojson', data: {} } } }),
    getSource: (id) => (id === 'openmaptiles' ? src : { setData() {} }),
  };
  return { view, src };
}

const json = (body, ok = true) => async () => ({ ok, json: async () => body });

test('refreshTiles: bản dựng mới thì nạp lại nguồn ô; cùng bản dựng, lỗi mạng hay TileJSON hỏng thì giữ nguyên', async () => {
  const { view, src } = fakeView(OLD);
  const asked = [];
  assert.equal(await view.refreshTiles(async (u) => (asked.push(u), { ok: true, json: async () => ({ tiles: OLD }) })), 0);
  assert.deepEqual(asked, [TJ], 'chỉ hỏi TileJSON của nguồn vector');
  assert.equal(await view.refreshTiles(json({ tiles: NEW }, false)), 0);
  assert.equal(await view.refreshTiles(json({ tiles: 'x' })), 0);
  assert.equal(
    await view.refreshTiles(async () => {
      throw new TypeError('Failed to fetch');
    }),
    0
  );
  assert.deepEqual(src.reloads, []);
  assert.equal(await view.refreshTiles(json({ tiles: NEW })), 1);
  assert.deepEqual(src.reloads, [TJ]);
});

test('refreshTiles: chưa có bản đồ thì không làm gì', async () => {
  const view = new MapView(null);
  let asked = 0;
  assert.equal(await view.refreshTiles(async () => (asked++, { ok: true, json: async () => ({ tiles: NEW }) })), 0);
  assert.equal(asked, 0);
});
