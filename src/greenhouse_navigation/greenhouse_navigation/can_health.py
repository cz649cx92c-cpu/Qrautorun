"""Read SocketCAN transmit eligibility independently of ROS feedback freshness.

This probe only reads kernel link state; it never sends frames or resets links.
A ready result is not proof of an acknowledged transmission or fresh feedback.
"""
import json
import subprocess
import threading
import time


class CanHealth:
    """Bounded, cached SocketCAN status with injectable subprocess and clock."""

    QUERY_TIMEOUT_S = 0.35
    CACHE_TTL_S = 0.5

    def __init__(self, channel="can0", *, runner=None, clock=None):
        self.channel = channel
        self._runner = subprocess.run if runner is None else runner
        self._clock = time.monotonic if clock is None else clock
        self._cached = None
        self._queried_at = None
        self._lock = threading.Lock()

    def status(self):
        """Return ready/state/reason/txPackets/rxPackets; unknowns fail closed.

        Cache failures as well as successes for 500 ms. Return a copy so callers
        cannot accidentally change another caller's health decision.
        """
        with self._lock:
            now = self._clock()
            if (self._cached is not None and self._queried_at is not None
                    and 0 <= now - self._queried_at < self.CACHE_TTL_S):
                return dict(self._cached)
            self._cached = self._query()
            # Measure from query start: subprocess time must not extend freshness.
            self._queried_at = now
            return dict(self._cached)

    @staticmethod
    def _result(state, reason, *, ready=False, tx=None, rx=None):
        return {"ready": ready, "state": state, "reason": reason,
                "txPackets": tx, "rxPackets": rx}

    @staticmethod
    def _state(value):
        if not isinstance(value, str):
            return ""
        state = value.strip().upper().replace("_", "-").replace(" ", "-")
        return "BUS-OFF" if state == "BUSOFF" else state

    @staticmethod
    def _packets(link, direction):
        for key in ("stats64", "stats"):
            stats = link.get(key)
            values = stats.get(direction) if isinstance(stats, dict) else None
            count = values.get("packets") if isinstance(values, dict) else None
            if type(count) is int and count >= 0:
                return count
        return None

    def _query(self):
        try:
            result = self._runner(
                ["ip", "-j", "-d", "-s", "link", "show", self.channel],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, timeout=self.QUERY_TIMEOUT_S,
            )
            if result.returncode != 0:
                return self._result("UNAVAILABLE", "ip link query failed")
            links = json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            return self._result("UNAVAILABLE", "ip link query timed out")
        except (OSError, subprocess.SubprocessError):
            return self._result("UNAVAILABLE", "ip link query failed")
        except (TypeError, ValueError):
            return self._result("UNAVAILABLE", "Invalid ip link JSON")

        if not isinstance(links, list):
            return self._result("UNAVAILABLE", "Expected an ip link JSON array")
        matches = [link for link in links
                   if isinstance(link, dict) and link.get("ifname") == self.channel]
        if len(matches) != 1:
            return self._result("UNAVAILABLE", "CAN interface missing or ambiguous")
        link = matches[0]
        counts = {"tx": self._packets(link, "tx"), "rx": self._packets(link, "rx")}
        linkinfo = link.get("linkinfo")
        linkinfo = linkinfo if isinstance(linkinfo, dict) else {}
        data = linkinfo.get("info_data")
        data = data if isinstance(data, dict) else {}
        state = self._state(data.get("state"))
        operstate = self._state(link.get("operstate"))
        raw_flags = link.get("flags")
        flags = {self._state(flag) for flag in raw_flags} if isinstance(raw_flags, list) else set()

        # An administrative UP flag survives BUS-OFF. Faults take precedence.
        if "BUS-OFF" in (state, operstate) or "BUS-OFF" in flags:
            return self._result("BUS-OFF", "CAN controller is BUS-OFF", **counts)
        if "NO-CARRIER" in flags or "NO-CARRIER" in (state, operstate):
            return self._result("NO-CARRIER", "CAN interface has no carrier", **counts)
        down_states = {"DOWN", "DORMANT", "LOWERLAYERDOWN", "LOWERLAYER-DOWN", "NOTPRESENT"}
        if operstate in down_states or state in down_states or "DOWN" in flags:
            return self._result("DOWN", "CAN interface is down", **counts)
        if "UP" not in flags:
            return self._result("DOWN", "CAN interface is not administratively UP", **counts)
        if linkinfo.get("info_kind", "can") != "can":
            return self._result("UNKNOWN", "Interface is not a CAN controller", **counts)
        if state != "ERROR-ACTIVE":
            return self._result(state or "UNKNOWN", "CAN controller is not ERROR-ACTIVE", **counts)
        return self._result("ERROR-ACTIVE", "", ready=True, **counts)
