// iPhone và iPad: nhận ra máy, trình duyệt và chế độ mở từ Màn hình chính; gợi ý cài như ứng dụng; các lưu ý riêng.
// Trên iOS mọi trình duyệt (Safari, Chrome, Firefox…) đều dùng WebKit, nên giới hạn giống nhau. Từ iOS 16.4 (bản thấp
// nhất ứng dụng chạy được, xem js/compat.js) Chrome, Edge, Firefox cũng thêm được trang ra Màn hình chính qua nút Chia
// sẻ của mình; trình duyệt trong Zalo, Facebook… và trình duyệt lạ thì vẫn phải mở bằng Safari. Mọi hàm nhận env (mặc
// định globalThis) để kiểm thử với navigator giả; không hàm nào ném lỗi.

// Trình duyệt bên trong ứng dụng khác (Facebook, Instagram, Zalo, Line, Messenger…): không cài được ra Màn hình chính.
const IN_APP_UA = /\b(?:FBAN|FBAV|FB_IAB|FBIOS|Instagram|Zalo|Line|MessengerForiOS|Messenger)[/ ]/i;
// Trình duyệt khác Safari trên iOS, theo dấu hiệu trong chuỗi nhận dạng.
// Trình duyệt có mục Thêm vào Màn hình chính trong nút Chia sẻ từ iOS 16.4 (theo ghi chú phát hành Safari 16.4 và MDN).
const SHARE_BROWSERS = new Set(['chrome', 'edge', 'firefox']);
const OTHER_BROWSERS = [
  [/\bCriOS\//, 'chrome'],
  [/\bFxiOS\//, 'firefox'],
  [/\bEdgiOS\//, 'edge'],
  [/\b(?:OPiOS|OPT)\//, 'opera'],
  [/\bGSA\//, 'google'], // ứng dụng Google
  [/\bYaBrowser\//, 'yandex'],
  [/\bDuckDuckGo\//, 'duckduckgo'],
];

function safeMatch(env, query) {
  try {
    return typeof env?.matchMedia === 'function' && Boolean(env.matchMedia(query)?.matches);
  } catch {
    return false;
  }
}

/**
 * Trang đang mở như ứng dụng (từ Màn hình chính hay ứng dụng đã cài), không phải trong thẻ trình duyệt.
 * iOS: navigator.standalone (chỉ có trên iOS); nơi khác: CSS display-mode.
 */
export function isStandalone(env = globalThis) {
  if (env?.navigator?.standalone === true) return true;
  return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => safeMatch(env, `(display-mode: ${m})`));
}

/**
 * Máy Apple chạy iOS/iPadOS và trình duyệt đang dùng:
 * { ios, ipad, browser: null | 'safari' | 'home' (mở từ Màn hình chính) | 'in-app' | 'webview' | 'chrome' | 'firefox' |
 *   'edge' | 'opera' | 'google' | 'yandex' | 'duckduckgo', standalone }.
 * iPad đời mới báo mình là "Macintosh" nên nhận ra bằng màn hình cảm ứng (máy Mac không có).
 */
export function detectApple(env = globalThis) {
  const nav = env?.navigator || {};
  const ua = String(nav.userAgent || '');
  const ipad = /\biPad\b/.test(ua) || (/\bMacintosh\b/.test(ua) && Number(nav.maxTouchPoints) > 1);
  const ios = ipad || /\b(?:iPhone|iPod)\b/.test(ua);
  const standalone = isStandalone(env);
  if (!ios) return { ios: false, ipad: false, browser: null, standalone };
  let browser = 'safari';
  if (standalone) browser = 'home';
  else if (IN_APP_UA.test(ua)) browser = 'in-app';
  else {
    const hit = OTHER_BROWSERS.find(([re]) => re.test(ua));
    if (hit) browser = hit[1];
    // Safari luôn có "Safari/"; ứng dụng tự nhúng WebKit (WKWebView) thì không.
    else if (!/\bSafari\//.test(ua)) browser = 'webview';
  }
  return { ios, ipad, browser, standalone };
}

export const INSTALL_TEXT = Object.freeze({
  safari: 'Để dùng như ứng dụng: bấm nút Chia sẻ rồi chọn Thêm vào Màn hình chính',
  share: 'Để dùng như ứng dụng: bấm nút Chia sẻ của trình duyệt rồi chọn Thêm vào Màn hình chính',
  other: 'Để cài như ứng dụng, hãy mở trang này bằng Safari',
  inApp: 'Đang mở trong ứng dụng khác. Hãy mở trang này bằng Safari để cài như ứng dụng',
});

/**
 * Gợi ý cài ra Màn hình chính: null khi không cần (không phải iOS, đã mở từ Màn hình chính, người dùng đã ẩn gợi ý),
 * không thì { kind: 'safari' | 'share' (Chrome, Edge, Firefox) | 'open-in-safari', text }.
 */
export function installHint(apple, dismissed = false) {
  if (!apple?.ios || apple.standalone || apple.browser === 'home' || dismissed) return null;
  if (apple.browser === 'safari') return { kind: 'safari', text: INSTALL_TEXT.safari };
  if (SHARE_BROWSERS.has(apple.browser)) return { kind: 'share', text: INSTALL_TEXT.share };
  const inApp = apple.browser === 'in-app' || apple.browser === 'webview';
  return { kind: 'open-in-safari', text: inApp ? INSTALL_TEXT.inApp : INSTALL_TEXT.other };
}

/** Các bước cài ra Màn hình chính (hiện trong hộp thoại khi bấm vào gợi ý, và trong Cài đặt). */
export function installSteps(apple) {
  const steps = [];
  if (SHARE_BROWSERS.has(apple?.browser)) {
    // Vị trí nút Chia sẻ khác nhau giữa Chrome, Edge, Firefox và giữa các bản: chỉ tả chung, có đường lui về Safari.
    steps.push(
      'Bấm nút Chia sẻ của trình duyệt (hình ô vuông có mũi tên đi lên, thường ở thanh địa chỉ). Không thấy nút này thì mở trình đơn của trình duyệt (nút ba chấm hay ba gạch) rồi chọn Chia sẻ.',
      'Kéo xuống, chọn Thêm vào Màn hình chính (có máy ghi tắt là Thêm vào MH chính). Không có mục này thì mở trang bằng Safari và làm lại từ Safari.'
    );
  } else {
    if (apple?.browser !== 'safari') steps.push('Mở trang này bằng Safari (chép địa chỉ trang rồi dán vào Safari).');
    steps.push(
      apple?.ipad
        ? 'Bấm nút Chia sẻ (hình ô vuông có mũi tên đi lên) ở góc trên. Không thấy nút này thì bấm nút ba chấm trước.'
        : 'Bấm nút Chia sẻ (hình ô vuông có mũi tên đi lên). Không thấy nút này thì bấm nút ba chấm trước.',
      'Kéo xuống, chọn Thêm vào Màn hình chính (có máy ghi tắt là Thêm vào MH chính).'
    );
  }
  steps.push(
    'Bấm Thêm. Từ nay mở Bạn Đường bằng biểu tượng trên Màn hình chính.',
    'Lần đầu mở, cho phép dùng vị trí, rồi bấm Đọc thử trong Cài đặt để kiểm tra giọng đọc.'
  );
  return steps;
}

/** Lưu ý trung thực về giới hạn trên iPhone, iPad (mục "Trên iPhone" trong Cài đặt). */
export function iphoneNotes(apple) {
  const notes = [
    'Cảnh báo và giọng đọc chỉ chạy khi Bạn Đường đang mở trên màn hình. Khi tắt màn hình hay chuyển sang ứng dụng khác, iPhone tạm dừng ứng dụng: không theo dõi vị trí, không đọc cảnh báo.',
    'Giữ màn hình sáng khi lái cần iOS 16.4 trở lên. Khi mở từ Màn hình chính, các bản iOS trước 18.4 có thể vẫn tự tắt màn hình; nếu vậy, hãy vào Cài đặt của iPhone, mục Màn hình & Độ sáng, Tự động khóa và chọn thời gian dài hơn khi lái.',
    'Không kết nối được bộ OBD Bluetooth: iPhone không cho trang web dùng Bluetooth.',
    'Không hiện trên màn hình CarPlay của xe: CarPlay chỉ nhận ứng dụng gốc được Apple duyệt.',
    'Nếu không nghe thấy âm báo hay giọng đọc, hãy tắt chế độ im lặng và tăng âm lượng của iPhone.',
    'Camera nhận diện biển phải bật lại bằng tay mỗi lần mở ứng dụng, và chưa được thử trên iPhone thật.',
  ];
  if (!apple?.standalone) {
    notes.unshift(
      'Hãy thêm Bạn Đường vào Màn hình chính: Safari có thể tự xoá dữ liệu (cài đặt, địa điểm, điểm đánh dấu, biển đã học) của trang web không được mở trong 7 ngày.'
    );
  }
  return notes;
}

/** Lời nhắc khi máy chưa có giọng đọc tiếng Việt. */
export function voiceMissingHint(apple) {
  return apple?.ios
    ? 'Máy chưa có giọng đọc tiếng Việt. Hãy vào Cài đặt của iPhone, mục Trợ năng, Nội dung được đọc, Giọng nói, chọn Tiếng Việt và tải một giọng.'
    : 'Máy chưa có giọng đọc tiếng Việt. Hãy cài dữ liệu giọng nói tiếng Việt trong phần cài đặt "Chuyển văn bản thành giọng nói" của thiết bị.';
}

/**
 * Xin trình duyệt giữ dữ liệu lâu dài (không tự xoá khi thiếu chỗ). Chỉ gọi trên iOS khi đã mở từ Màn hình chính, nơi
 * xin không hiện hộp hỏi nào. Trả true/false, hoặc null khi trình duyệt không có chức năng này.
 */
export async function requestPersistence(env = globalThis) {
  const storage = env?.navigator?.storage;
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return Boolean(await storage.persist());
  } catch {
    return false;
  }
}
