import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Cờ tường minh, mặc định tắt: bản debug nhận mọi máy chủ màn hình xe (chỉ để thử với máy chủ giả lập).
val allowAllCarHosts: Boolean = providers.gradleProperty("allowAllCarHosts").orNull == "true"

// Thư mục ứng dụng web (ban-duong/), nằm ngay trên thư mục android/.
val webRootDir: File = rootProject.projectDir.parentFile

// Đúng bộ tệp mà `npm run dist` chép (package.json). Đổi ở đây nếu danh sách đó đổi.
val webDistEntries = listOf(
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "css",
    "js",
    "icons",
    "vendor",
    "models",
)

/**
 * Chép ứng dụng web vào thư mục assets sinh ra lúc build (build/generated/…/www/), không đưa vào kho mã.
 * Dùng sync nên tệp đã xoá bên web cũng biến mất khỏi APK.
 */
abstract class CopyWebAssetsTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val webFiles: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:Input
    abstract val includePatterns: ListProperty<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        val root = webRoot.get().asFile
        val index = File(root, "index.html")
        check(index.isFile) { "Không thấy ${index.path}: tác vụ cần chạy trong thư mục ban-duong/android" }
        fs.sync {
            from(root) {
                include(includePatterns.get())
                // Không chép tệp ẩn hay tệp tạm.
                exclude("**/.*", "**/*~")
            }
            into(outputDir.dir("www"))
        }
    }
}

val copyWebAssets = tasks.register<CopyWebAssetsTask>("copyWebAssets") {
    description = "Chép ứng dụng web Bạn Đường vào assets/www của APK"
    val patterns = webDistEntries.map { if (it.contains('.')) it else "$it/**" }
    webRoot.set(webRootDir)
    includePatterns.set(patterns)
    webFiles.from(fileTree(webRootDir) { include(patterns); exclude("**/.*", "**/*~") })
    outputDir.set(layout.buildDirectory.dir("generated/webAssets"))
}

android {
    namespace = "vn.banduong.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "vn.banduong.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        // Màn hình xe chỉ nhận máy chủ Android Auto chính thức (xem BanDuongCarAppService).
        buildConfigField("boolean", "ALLOW_ALL_CAR_HOSTS", "false")
    }

    buildTypes {
        debug {
            // Khoá debug mặc định của máy build; không có khoá phát hành nào trong kho mã.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            // Chỉ để thử với máy chủ giả lập không phải của Google: ./gradlew -PallowAllCarHosts=true … (mặc định tắt).
            buildConfigField("boolean", "ALLOW_ALL_CAR_HOSTS", allowAllCarHosts.toString())
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Cố ý KHÔNG khai báo signingConfig: bản release chỉ được ký ngoài kho mã.
        }
        // Bản để cài lên điện thoại thật và chạy trên xe: như release (R8, không debuggable, không gỡ lỗi WebView từ
        // xa) nhưng ký bằng khoá debug của máy build, nên cài được ngay mà không cần khoá phát hành.
        create("sideload") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            isDebuggable = false
            applicationIdSuffix = ".sideload"
            versionNameSuffix = "-sideload"
            matchingFallbacks += listOf("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        // Mô hình và WebAssembly: để nguyên không nén, WebView đọc nhanh hơn.
        noCompress += listOf("tflite", "wasm")
        // Mặc định aapt bỏ thư mục bắt đầu bằng "_"; chỉ bỏ tệp ẩn và tệp hệ thống.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyWebAssets, CopyWebAssetsTask::outputDir)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.car.app)
    implementation(libs.androidx.car.app.projected)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.car.app.testing)
}
