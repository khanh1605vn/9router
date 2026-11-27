package vn.banduong.app.obd

import java.util.Locale
import java.util.UUID

/**
 * Bộ OBD Bluetooth thường gặp: tên, service và cặp đặc tính nhận/gửi. Chép đúng từ js/obd.js (BLE_NAME_PREFIXES,
 * FILTER_SERVICES, BLE_SERVICES, KNOWN_PAIRS) để ứng dụng tìm và nói chuyện với đúng những thiết bị như bản web.
 * tests/obdnative.test.mjs và ObdProfilesTest so hai bản với nhau.
 */
object ObdProfiles {
    fun uuid16(n: Int): UUID = UUID.fromString(String.format(Locale.ROOT, "0000%04x-0000-1000-8000-00805f9b34fb", n))

    private fun uuid(s: String): UUID = UUID.fromString(s)

    /** Bluetooth thường: cổng nối tiếp (SPP, RFCOMM). */
    val SPP_UUID: UUID = uuid16(0x1101)

    /** Descriptor bật notify/indicate (Client Characteristic Configuration). */
    val CCCD_UUID: UUID = uuid16(0x2902)

    /** Tiền tố tên thiết bị; phân biệt chữ hoa như namePrefix của Web Bluetooth. */
    val NAME_PREFIXES: List<String> = listOf(
        "OBD", "OBDII", "OBD2", "ELM", "ELM327", "V-LINK", "Vlink", "Android-Vlink", "IOS-Vlink", "vLinker",
        "VEEPEAK", "Veepeak", "OBDLink", "Viecar", "LELink", "Carista", "FIXD", "KONNWEI", "Vgate",
    )

    /** Service quảng bá thường gặp (bộ lọc của hộp chọn khi chưa bấm "Hiện mọi thiết bị"). */
    val FILTER_SERVICES: List<UUID> = listOf(
        uuid16(0xfff0), uuid16(0xffe0), uuid16(0x18f0), uuid("e7810a71-73ae-499d-8c15-faa9aef0c3f2"),
    )

    /** Mọi service được dò, theo thứ tự ưu tiên. */
    val SERVICES: List<UUID> = listOf(
        uuid16(0xfff0),
        uuid16(0xffe0),
        uuid16(0x18f0),
        uuid("e7810a71-73ae-499d-8c15-faa9aef0c3f2"),
        uuid16(0xbeef),
        uuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e"), // Nordic UART
        uuid("49535343-fe7d-4ae5-8fa9-9fafd205e455"), // Microchip
        uuid16(0xfefb),
        uuid16(0xe010),
        uuid("e47c8027-cca1-4e3b-981f-bdc47abeb5b5"),
        uuid("0783b03e-8535-b5a0-7140-a304d2495cb7"),
        uuid("786ef0cc-2a93-332c-0356-0cc60629af99"),
        uuid16(0x1000),
    )

    private val VLINKER_CHAR = uuid("bef8d6c9-9c21-4c9e-b632-bd58c1009f9f")

    /** Cặp đặc tính đã biết: nhận (notify) / gửi (write), theo thứ tự ưu tiên. */
    data class KnownPair(val notify: List<UUID>, val write: List<UUID>)

    val KNOWN_PAIRS: Map<UUID, KnownPair> = mapOf(
        uuid16(0xfff0) to KnownPair(listOf(uuid16(0xfff1)), listOf(uuid16(0xfff2))),
        // FFE2 nếu có và ghi được, không thì FFE1.
        uuid16(0xffe0) to KnownPair(listOf(uuid16(0xffe1)), listOf(uuid16(0xffe2), uuid16(0xffe1))),
        uuid16(0x18f0) to KnownPair(listOf(uuid16(0x2af0)), listOf(uuid16(0x2af1))),
        uuid("e7810a71-73ae-499d-8c15-faa9aef0c3f2") to KnownPair(listOf(VLINKER_CHAR), listOf(VLINKER_CHAR)),
        uuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e") to KnownPair(
            listOf(uuid("6e400003-b5a3-f393-e0a9-e50e24dcca9e")),
            listOf(uuid("6e400002-b5a3-f393-e0a9-e50e24dcca9e")),
        ),
    )

    /** Thiết bị có giống bộ OBD không (bộ lọc mặc định của hộp chọn BLE). */
    fun looksLikeObd(name: String?, advertisedServices: Collection<UUID>): Boolean =
        (name != null && NAME_PREFIXES.any { name.startsWith(it) }) || advertisedServices.any { it in FILTER_SERVICES }

    /** Thông tin một đặc tính GATT, đủ để chọn kênh (tách khỏi lớp Android để kiểm thử). */
    data class CharInfo(
        val uuid: UUID,
        val notify: Boolean,
        val indicate: Boolean,
        val write: Boolean,
        val writeNoResponse: Boolean,
    ) {
        val canNotify get() = notify || indicate
        val canWrite get() = write || writeNoResponse
    }

    data class ServiceInfo(val uuid: UUID, val chars: List<CharInfo>)

    data class Channel(val service: UUID, val rx: CharInfo, val tx: CharInfo, val how: String)

    /**
     * Chọn đặc tính nhận/gửi giống chooseCharacteristics của obd.js: chỉ trong [SERVICES], theo thứ tự đó; ưu tiên
     * cặp đã biết, sau đó lấy đặc tính đầu tiên có notify/indicate và đặc tính đầu tiên ghi được. Không có thì null.
     */
    fun chooseChannel(services: List<ServiceInfo>): Channel? {
        val found = ArrayList<ServiceInfo>()
        for (id in SERVICES) {
            val s = services.firstOrNull { it.uuid == id } ?: continue
            if (s.chars.isEmpty()) continue
            found += s
            val known = KNOWN_PAIRS[id] ?: continue
            val rx = known.notify.firstNotNullOfOrNull { u -> s.chars.firstOrNull { it.uuid == u }?.takeIf { it.canNotify } }
            val tx = known.write.firstNotNullOfOrNull { u -> s.chars.firstOrNull { it.uuid == u }?.takeIf { it.canWrite } }
            if (rx != null && tx != null) return Channel(id, rx, tx, "known")
        }
        for (s in found) {
            val rx = s.chars.firstOrNull { it.canNotify }
            val tx = s.chars.firstOrNull { it.canWrite }
            if (rx != null && tx != null) return Channel(s.uuid, rx, tx, "properties")
        }
        return null
    }
}
