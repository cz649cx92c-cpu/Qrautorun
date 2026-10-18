"""Offline kernel CAN state regressions: no ROS, services, or hardware access."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/greenhouse_navigation"))
from greenhouse_navigation.can_health import CanHealth


def can_link(state="ERROR-ACTIVE", flags=None, operstate="UP", channel="can0"):
    return {
        "ifname": channel,
        "flags": ["NOARP", "UP", "LOWER_UP", "ECHO"] if flags is None else flags,
        "operstate": operstate,
        "linkinfo": {"info_kind": "can", "info_data": {"state": state}},
        "stats64": {"tx": {"packets": 123}, "rx": {"packets": 456}},
    }


def completed(links):
    return subprocess.CompletedProcess([], 0, stdout=json.dumps(links), stderr="")


class CanHealthTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.runner = Mock(return_value=completed([can_link()]))
        self.health = CanHealth(runner=self.runner, clock=lambda: self.now)

    def status_for(self, link):
        self.runner.return_value = completed([link])
        return CanHealth(runner=self.runner, clock=lambda: self.now).status()

    def test_error_active_up_is_ready_and_reads_packet_counts(self):
        self.assertEqual(self.health.status(), {
            "ready": True, "state": "ERROR-ACTIVE", "reason": "",
            "txPackets": 123, "rxPackets": 456,
        })
        args, kwargs = self.runner.call_args
        self.assertEqual(args, (["ip", "-j", "-d", "-s", "link", "show", "can0"],))
        self.assertTrue(kwargs["check"])
        self.assertTrue(kwargs["text"])
        self.assertEqual(kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(kwargs["stderr"], subprocess.PIPE)
        self.assertGreaterEqual(kwargs["timeout"], 0.25)
        self.assertLessEqual(kwargs["timeout"], 0.5)
        self.runner.assert_called_once()

    def test_unknown_operstate_can_be_normal_for_socketcan(self):
        result = self.status_for(can_link(operstate="UNKNOWN"))
        self.assertTrue(result["ready"])

    def test_bus_off_overrides_up_and_old_nonzero_packet_counts(self):
        for state in ("BUS-OFF", "BUS_OFF", "BUSOFF", "bus off"):
            with self.subTest(state=state):
                result = self.status_for(can_link(state=state))
                self.assertFalse(result["ready"])
                self.assertEqual(result["state"], "BUS-OFF")
                self.assertIn("BUS-OFF", result["reason"])
                self.assertEqual(result["txPackets"], 123)

    def test_fault_priority_bus_off_then_no_carrier_then_down(self):
        cases = (
            (can_link("BUS-OFF", ["UP", "NO-CARRIER"], "DOWN"), "BUS-OFF"),
            (can_link(flags=["UP", "NO-CARRIER"], operstate="DOWN"), "NO-CARRIER"),
            (can_link(operstate="DOWN"), "DOWN"),
        )
        for link, expected in cases:
            with self.subTest(expected=expected):
                result = self.status_for(link)
                self.assertFalse(result["ready"])
                self.assertEqual(result["state"], expected)
                self.assertTrue(result["reason"])

    def test_no_carrier_and_down_always_fail_closed(self):
        cases = (
            can_link(flags=["UP", "NO-CARRIER"]),
            can_link(flags=["UP", "DOWN"]),
            can_link(flags=["NOARP"]),
            can_link(flags=[]),
            can_link(state="DOWN"),
            can_link(operstate="NO-CARRIER"),
            can_link(operstate="DORMANT"),
            can_link(operstate="LOWERLAYERDOWN"),
            can_link(operstate="NOTPRESENT"),
        )
        for link in cases:
            with self.subTest(link=link):
                self.assertFalse(self.status_for(link)["ready"])

    def test_administrative_up_does_not_prove_controller_health(self):
        for state in ("UP", "", None, "ERROR-WARNING", "ERROR-PASSIVE", "STOPPED", "SLEEPING"):
            with self.subTest(state=state):
                result = self.status_for(can_link(state=state))
                self.assertFalse(result["ready"])
                self.assertTrue(result["reason"])

    def test_missing_or_malformed_controller_and_flags_fail_closed(self):
        for key, value in (
            ("linkinfo", None), ("linkinfo", []), ("linkinfo", {}),
            ("linkinfo", {"info_data": None}),
            ("linkinfo", {"info_data": {"state": ["ERROR-ACTIVE"]}}),
            ("flags", "UP"), ("flags", None), ("flags", [None, 42, {}]),
        ):
            with self.subTest(key=key, value=value):
                link = can_link()
                link[key] = value
                self.assertFalse(self.status_for(link)["ready"])

    def test_explicit_other_link_kind_is_not_can(self):
        link = can_link()
        link["linkinfo"]["info_kind"] = "vcan"
        self.assertFalse(self.status_for(link)["ready"])

    def test_no_matching_interface_or_invalid_json_shape_fails_closed(self):
        for links in ([], [can_link(channel="can1")], {}, None, "UP", [None, 5, []],
                      [can_link(), can_link()]):
            with self.subTest(links=links):
                self.runner.return_value = completed(links)
                health = CanHealth(runner=self.runner, clock=lambda: self.now)
                result = health.status()
                self.assertFalse(result["ready"])
                self.assertTrue(result["reason"])
                self.assertIsNone(result["txPackets"])

    def test_named_interface_must_match_even_if_other_interface_is_healthy(self):
        self.runner.return_value = completed([can_link(), can_link("BUS-OFF", channel="can1")])
        health = CanHealth("can1", runner=self.runner, clock=lambda: self.now)
        self.assertEqual(health.status()["state"], "BUS-OFF")
        self.assertEqual(self.runner.call_args.args[0][-1], "can1")

    def test_ip_errors_and_timeouts_fail_closed(self):
        for error, reason in (
            (FileNotFoundError("ip"), "failed"),
            (PermissionError("denied"), "failed"),
            (subprocess.CalledProcessError(1, ["ip"]), "failed"),
            (subprocess.TimeoutExpired(["ip"], .35), "timed out"),
        ):
            with self.subTest(error=error):
                runner = Mock(side_effect=error)
                result = CanHealth(runner=runner, clock=lambda: self.now).status()
                self.assertFalse(result["ready"])
                self.assertIn(reason, result["reason"])
                runner.assert_called_once()

    def test_nonzero_exit_and_invalid_json_fail_closed(self):
        for returncode, stdout in ((1, json.dumps([can_link()])), (0, "{"),
                                   (0, ""), (0, None), (0, b"\xff")):
            with self.subTest(returncode=returncode, stdout=stdout):
                self.runner.return_value = subprocess.CompletedProcess([], returncode, stdout=stdout)
                result = CanHealth(runner=self.runner, clock=lambda: self.now).status()
                self.assertFalse(result["ready"])
                self.assertTrue(result["reason"])

    def test_packet_counts_fall_back_to_older_ip_stats(self):
        link = can_link()
        link["stats"] = link.pop("stats64")
        result = self.status_for(link)
        self.assertEqual((result["txPackets"], result["rxPackets"]), (123, 456))

    def test_missing_or_invalid_counts_are_unknown_and_do_not_fake_zero(self):
        for stats in (None, {}, [], {"tx": None}, {"tx": {"packets": "42"}},
                      {"tx": {"packets": -1}}, {"rx": {"packets": True}}):
            with self.subTest(stats=stats):
                link = can_link()
                link["stats64"] = stats
                result = self.status_for(link)
                self.assertTrue(result["ready"])
                self.assertIsNone(result["txPackets"])
                self.assertIsNone(result["rxPackets"])

    def test_zero_packet_counts_are_preserved(self):
        link = can_link()
        link["stats64"] = {"tx": {"packets": 0}, "rx": {"packets": 0}}
        result = self.status_for(link)
        self.assertEqual((result["txPackets"], result["rxPackets"]), (0, 0))

    def test_cache_expires_at_500ms_and_detects_bus_off(self):
        original = self.health.status()
        self.runner.return_value = completed([can_link("BUS-OFF")])
        self.now = .499
        self.assertEqual(self.health.status(), original)
        self.runner.assert_called_once()
        self.now = .5
        result = self.health.status()
        self.assertFalse(result["ready"])
        self.assertEqual(result["state"], "BUS-OFF")
        self.assertEqual(self.runner.call_count, 2)

    def test_cached_failures_can_recover_after_500ms(self):
        self.runner.side_effect = subprocess.TimeoutExpired(["ip"], .35)
        self.assertFalse(self.health.status()["ready"])
        self.runner.side_effect = None
        self.now = .499
        self.assertFalse(self.health.status()["ready"])
        self.runner.assert_called_once()
        self.now = .5
        self.assertTrue(self.health.status()["ready"])
        self.assertEqual(self.runner.call_count, 2)

    def test_failed_refresh_never_reuses_previous_healthy_result(self):
        self.assertTrue(self.health.status()["ready"])
        self.now = .5
        self.runner.side_effect = FileNotFoundError("ip")
        result = self.health.status()
        self.assertFalse(result["ready"])
        self.assertIsNone(result["txPackets"])

    def test_slow_query_does_not_extend_cache_freshness(self):
        def slow_runner(*args, **kwargs):
            self.now += .3
            return completed([can_link()])
        self.runner.side_effect = slow_runner
        self.health.status()
        self.now = .5
        self.health.status()
        self.assertEqual(self.runner.call_count, 2)

    def test_clock_rollback_refreshes_instead_of_retaining_old_health(self):
        self.health.status()
        self.now = -1.
        self.runner.return_value = completed([can_link("BUS-OFF")])
        self.assertFalse(self.health.status()["ready"])
        self.assertEqual(self.runner.call_count, 2)

    def test_callers_cannot_mutate_cached_health(self):
        result = self.health.status()
        original = copy.copy(result)
        result.update(ready=False, state="BUS-OFF", txPackets=-10)
        self.assertEqual(self.health.status(), original)
        self.runner.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
