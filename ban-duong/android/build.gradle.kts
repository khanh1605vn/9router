// Tệp build gốc: chỉ khai báo plugin, cấu hình nằm trong app/build.gradle.kts.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}
