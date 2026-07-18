import unittest

from bt_hints import RADIO_DISABLED, RADIO_OFF, RADIO_ON, gatt_failure_hint


class GattFailureHintTests(unittest.TestCase):
    def test_radio_off_says_bluetooth_is_off(self):
        hint = gatt_failure_hint(True, True, RADIO_OFF)
        self.assertIn("turned off", hint)

    def test_radio_disabled_says_bluetooth_is_off(self):
        hint = gatt_failure_hint(True, True, RADIO_DISABLED)
        self.assertIn("turned off", hint)

    def test_missing_adapter_wins_over_radio(self):
        hint = gatt_failure_hint(False, None, None)
        self.assertIn("adapter", hint)
        self.assertNotIn("turned off", hint)

    def test_no_peripheral_role_with_radio_on(self):
        hint = gatt_failure_hint(True, False, RADIO_ON)
        self.assertIn("peripheral", hint)

    def test_unknown_probe_gives_generic_checklist(self):
        hint = gatt_failure_hint(None, None, None)
        self.assertIn("Bluetooth is on", hint)

    def test_healthy_probe_gives_generic_checklist(self):
        hint = gatt_failure_hint(True, True, RADIO_ON)
        self.assertIn("Bluetooth is on", hint)


if __name__ == "__main__":
    unittest.main()
