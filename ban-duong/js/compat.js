// Báo rõ khi trình duyệt quá cũ để chạy ứng dụng, thay vì để trang đứng mãi ở "Đang tìm vị trí của bạn…".
// Tệp script thường (không phải module), chạy trước js/main.js: mã của ứng dụng dùng cú pháp mới (ví dụ biểu thức
// chính quy nhìn lùi, có từ iOS 16.4), máy cũ không hiểu thì module không chạy được và chỉ phát lỗi SyntaxError.
// Viết theo cú pháp cũ để chính tệp này chạy được trên máy cũ.
(function () {
  var TEXT = 'Trình duyệt này chưa chạy được Bạn Đường. Trên iPhone, iPad cần iOS 16.4 trở lên; trên Android hãy cập nhật Chrome.';
  var shown = false;

  function show() {
    if (shown) return;
    var line = document.getElementById('gpsStatus');
    if (!line) return;
    shown = true;
    line.className += ' warn';
    line.textContent = TEXT;
  }

  function onError(e) {
    // js/main.js đã chạy (đặt data-booted): lỗi về sau không phải do trình duyệt cũ.
    if (document.documentElement.hasAttribute('data-booted')) return;
    var err = e && e.error;
    var isSyntax = (err && err.name === 'SyntaxError') || /SyntaxError/.test(String((e && e.message) || ''));
    if (isSyntax) show();
  }

  window.addEventListener('error', onError);
  // Không có module: js/main.js không bao giờ chạy.
  var probe = document.createElement('script');
  if (!('noModule' in probe)) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
    else show();
  }
})();
