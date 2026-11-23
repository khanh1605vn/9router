# Kiểm tra và mã hoá lại ảnh tải về (dữ liệu không tin cậy) bằng Pillow. Chạy với `python -I`.
#
#   python -I tools/camera/sanitize_images.py <jobs.json> <results.json> <min_width> <max_width>
#
# jobs.json: [{"id": "...", "src": "<ảnh tải về>", "dst": "<ảnh sạch>"}]. Với mỗi ảnh: phải là JPEG thật,
# giải mã được trọn vẹn, đủ rộng (ảnh dọc hoặc hẹp bị bỏ), thu nhỏ về tối đa max_width, rồi ghi lại thành JPEG
# mới không kèm EXIF hay ICC. Ảnh hỏng chỉ bị bỏ, không làm dừng cả lô.
import json
import os
import sys
import warnings

from PIL import Image

MAX_PIXELS = 40_000_000  # từ chối ảnh lớn bất thường (bom giải nén)
JPEG_QUALITY = 92  # chất lượng khi ghi lại


def sanitize(src, dst, min_w, max_w):
    with open(src, "rb") as f:
        if f.read(3) != b"\xff\xd8\xff":
            return {"ok": False, "reason": "magic"}
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(src) as im:
            if im.format != "JPEG":
                return {"ok": False, "reason": "format"}
            im.load()
            rgb = im.convert("RGB")
    w, h = rgb.size
    if w < min_w or h < 64 or h > w:
        return {"ok": False, "reason": "size", "w": w, "h": h}
    if w > max_w:
        nh = round(h * max_w / w)
        rgb = rgb.resize((max_w, nh), Image.LANCZOS)
        w, h = max_w, nh
    tmp = dst + ".tmp"
    rgb.save(tmp, "JPEG", quality=JPEG_QUALITY)
    os.replace(tmp, dst)
    return {"ok": True, "w": w, "h": h}


def main():
    jobs_path, out_path, min_w, max_w = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    with open(jobs_path, encoding="utf-8") as f:
        jobs = json.load(f)
    results = {}
    for j in jobs:
        try:
            results[j["id"]] = sanitize(j["src"], j["dst"], min_w, max_w)
        except Exception as e:  # ảnh hỏng: ghi lý do rồi bỏ qua
            results[j["id"]] = {"ok": False, "reason": type(e).__name__}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f)


if __name__ == "__main__":
    main()
