package vn.banduong.app.obd

import android.Manifest
import org.junit.Assert.assertEquals
import org.junit.Test

class ObdPermissionsTest {
    @Test
    fun permissionsPerAndroidVersion() {
        assertEquals(listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT), ObdPermissions.forPick(ObdKind.BLE, 31))
        assertEquals(listOf(Manifest.permission.BLUETOOTH_CONNECT), ObdPermissions.forPick(ObdKind.SPP, 36))
        assertEquals(listOf(Manifest.permission.ACCESS_FINE_LOCATION), ObdPermissions.forPick(ObdKind.BLE, 30))
        assertEquals(emptyList<String>(), ObdPermissions.forPick(ObdKind.SPP, 26))
        assertEquals(listOf(Manifest.permission.BLUETOOTH_CONNECT), ObdPermissions.forConnect(31))
        assertEquals(emptyList<String>(), ObdPermissions.forConnect(30))
    }
}
