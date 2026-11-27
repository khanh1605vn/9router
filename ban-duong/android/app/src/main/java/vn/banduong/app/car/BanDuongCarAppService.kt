package vn.banduong.app.car

import android.annotation.SuppressLint
import android.content.pm.ApplicationInfo
import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.SessionInfo
import androidx.car.app.validation.HostValidator
import vn.banduong.app.BuildConfig

/**
 * Điểm vào của Android Auto (Car App Library, nhóm ứng dụng dẫn đường).
 *
 * HostValidator: mọi bản (cả debug) chỉ nhận các máy chủ có trong danh sách của thư viện (Android Auto của Google,
 * cũng là đường đi của Desktop Head Unit; Android Automotive…). Dịch vụ phải exported và không đòi quyền nào được, nên
 * nếu nhận mọi máy chủ thì ứng dụng bất kỳ trên máy cũng gắn vào được và đọc tốc độ, vị trí, tuyến đường.
 *
 * Chỉ khi build debug với cờ Gradle tường minh -PallowAllCarHosts=true (mặc định tắt) mới nhận mọi máy chủ, để thử với
 * máy chủ giả lập không phải của Google.
 */
class BanDuongCarAppService : CarAppService() {

    override fun createHostValidator(): HostValidator = createHostValidator(allowAll = allowAllHostsBuild())

    // hosts_allowlist_sample là danh sách máy chủ chính thức (Google) mà tài liệu Car App Library hướng dẫn dùng;
    // để thư viện cập nhật cùng phiên bản thay vì chép cứng vào ứng dụng.
    @SuppressLint("PrivateResource")
    internal fun createHostValidator(allowAll: Boolean): HostValidator =
        if (allowAll) {
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            HostValidator.Builder(applicationContext)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }

    /** Cả ba điều kiện: cờ Gradle allowAllCarHosts, BuildConfig.DEBUG và cờ debuggable của gói đang chạy. */
    private fun allowAllHostsBuild(): Boolean =
        BuildConfig.ALLOW_ALL_CAR_HOSTS && BuildConfig.DEBUG &&
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    override fun onCreateSession(sessionInfo: SessionInfo): Session = BanDuongSession()

    @Deprecated("Car API < 6 dùng hàm này", ReplaceWith("onCreateSession(sessionInfo)"))
    override fun onCreateSession(): Session = BanDuongSession()
}
