// Tệp sinh tự động bởi tools/camera/write-manifest.mjs — đừng sửa tay.
// SHA-256 và kích thước (byte) của từng tệp mô hình và LiteRT; js/vision.js từ chối tệp không khớp.

export const ML_MANIFEST = {
  "version": 2,
  "files": {
    "models/labels.json": {
      "sha256": "c18441bc4089459d953ade9fe975164f03bb410b4d8468f3a2bb9dd7a6722a9f",
      "size": 24423
    },
    "models/sign-cls.int8.tflite": {
      "sha256": "f89a97dfd29dffd05e16c66b7171c0bcf9633803752d64610e65e6ef8e725d47",
      "size": 370520
    },
    "models/sign-det.int8.tflite": {
      "sha256": "5c07b0c67be8cddd4515f4babf5b88e38ad8c57823007bbd6cff3b89012445e8",
      "size": 526736
    },
    "vendor/litert/litert.iife.min.js": {
      "sha256": "270781bc0f159b75b639c65c63fe64a943185992ec77971740801c0ab3135d8b",
      "size": 46259
    },
    "vendor/litert/litert_wasm_compat_internal.js": {
      "sha256": "cffb7bebb9411e2160d711ccff00c3921b0031a66a692f58c25ce8204b7ec541",
      "size": 279036
    },
    "vendor/litert/litert_wasm_compat_internal.wasm": {
      "sha256": "4190033238e53ec86b832bad4649851ad111025c226c1688cfae20e1f8fe8926",
      "size": 10948854
    },
    "vendor/litert/litert_wasm_internal.js": {
      "sha256": "43bc8c66b43e04630337c90edcea16b133a9f543d008e496a1550d3a229bc9ac",
      "size": 278825
    },
    "vendor/litert/litert_wasm_internal.wasm": {
      "sha256": "13db768de5c7a087517e46a0172c81102a7983bd159e6e47b0a0b933bae60014",
      "size": 11131135
    }
  }
};
