import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Cờ tường minh, mặc định tắt: bản debug nhận mọi máy chủ màn hình xe (chỉ để thử với máy chủ giả lập).
val allowAllCarHosts: Boolean = providers.gradleProperty("allowAllCarHosts").orNull == "true"

// Phiên bản: nguồn sự thật duy nhất là android/version.properties (phát hành bản mới = tăng hai số trong tệp đó).
val versionProps: Properties = Properties().apply {
    val text = providers.fileContents(rootProject.layout.projectDirectory.file("version.properties")).asText.get()
    load(text.reader())
}
val appVersionCode: Int = versionProps.getProperty("versionCode")?.trim()?.toIntOrNull()
    ?.takeIf { it in 1..2_100_000_000 }
    ?: error("version.properties: versionCode phải là số nguyên 1 … 2100000000")
val appVersionName: String = versionProps.getProperty("versionName")?.trim()
    ?.takeIf { Regex("^[0-9]{1,4}(\\.[0-9]{1,4}){0,3}$").matches(it) }
    ?: error("version.properties: versionName phải có dạng 1.2.3")

// Khoá ký bản release: chỉ lấy từ biến môi trường (GitHub Actions giải mã secret ra tệp tạm) hoặc thuộc tính Gradle
// ngoài kho mã (~/.gradle/gradle.properties). Thiếu bất kỳ giá trị nào thì bản release để không ký như trước; bản
// debug/sideload không bao giờ phụ thuộc vào khoá này.
fun signingValue(env: String, prop: String): String? =
    (providers.environmentVariable(env).orNull ?: providers.gradleProperty(prop).orNull)?.takeIf { it.isNotEmpty() }
val releaseStoreFile: String? = signingValue("BANDUONG_KEYSTORE_FILE", "banduong.keystore.file")
val releaseStorePassword: String? = signingValue("BANDUONG_KEYSTORE_PASSWORD", "banduong.keystore.password")
val releaseKeyAlias: String? = signingValue("BANDUONG_KEY_ALIAS", "banduong.key.alias")
val releaseKeyPassword: String? = signingValue("BANDUONG_KEY_PASSWORD", "banduong.key.password")
val hasReleaseSigning: Boolean = releaseStoreFile != null && releaseStorePassword != null &&
    releaseKeyAlias != null && releaseKeyPassword != null && File(releaseStoreFile).isFile

// Kênh cập nhật trong ứng dụng: bản phát hành trên GitHub của kho công khai này, thẻ ban-duong-v<versionName>.
val updateRepo = "khanh1605vn/9router"
val updateTagPrefix = "ban-duong-v"

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
    "data/community.json", // dữ liệu cộng đồng: chỉ đúng tệp này, không cả thư mục data/
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
        versionCode = appVersionCode
        versionName = appVersionName
        // Màn hình xe chỉ nhận máy chủ Android Auto chính thức (xem BanDuongCarAppService).
        buildConfigField("boolean", "ALLOW_ALL_CAR_HOSTS", "false")
        // Tự cập nhật (vn.banduong.app.update): kho và tiền tố thẻ do máy cố định, trang web không đổi được.
        buildConfigField("String", "UPDATE_REPO", "\"$updateRepo\"")
        buildConfigField("String", "UPDATE_TAG_PREFIX", "\"$updateTagPrefix\"")
        // "off": không kiểm tra; "notify": chỉ báo có bản mới (không cài được vì khác khoá ký);
        // "install": kiểm tra, tải, xác minh và cài (bản release ký bằng khoá phát hành).
        buildConfigField("String", "UPDATE_MODE", "\"off\"")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = File(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV2Signing = true
                enableV3Signing = true
            }
        }
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
            // Khoá phát hành chỉ có khi build trên GitHub Actions (secret) hoặc máy đã cấu hình ngoài kho mã;
            // không có thì ra app-release-unsigned.apk như trước.
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
            // Bản phát hành cài lên xe và tự cập nhật từ GitHub: cùng khoá ký, cùng applicationId vn.banduong.app.
            buildConfigField("String", "UPDATE_MODE", "\"install\"")
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
            // Khác applicationId và khác khoá ký với bản phát hành nên Android không cho cập nhật thẳng: chỉ báo có
            // bản mới và mở trang tải bản chính thức (cài một lần, sau đó bản chính thức tự cập nhật).
            buildConfigField("String", "UPDATE_MODE", "\"notify\"")
        }
    }

    sourceSets {
        // Quyền cài gói (REQUEST_INSTALL_PACKAGES) và bộ nhận kết quả cài chỉ có ở bản release, không có ở debug/sideload.
        getByName("release").manifest.srcFile("src/updater/AndroidManifest.xml")
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
