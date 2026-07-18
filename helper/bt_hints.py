"""Decode why creating the BLE GATT service failed into an actionable hint.

Stdlib-only so the unit tests run on any platform; the WinRT probe that
feeds it lives in server.py.
"""

RADIO_UNKNOWN = 0
RADIO_ON = 1
RADIO_OFF = 2
RADIO_DISABLED = 3


def gatt_failure_hint(has_adapter, peripheral_role, radio_state):
    if has_adapter is False:
        return (
            "No Bluetooth adapter found. Check that the adapter is enabled in "
            "Device Manager and its driver is installed."
        )
    if radio_state in (RADIO_OFF, RADIO_DISABLED):
        return (
            "Bluetooth is turned off. Enable it (Settings > Bluetooth & devices "
            "on Windows) and rerun the helper."
        )
    if peripheral_role is False:
        return (
            "This Bluetooth adapter does not support the BLE peripheral role, "
            "which the helper needs to advertise. Use an adapter that supports it."
        )
    return (
        "Check that Bluetooth is on and the adapter supports the BLE "
        "peripheral role."
    )
