import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("service_network", Path(__file__).with_name("t3code-service-network.py"))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


def configuration():
    return {
        "publicHost": "agent.example.com", "allowedDomainSuffixes": ["example.com"],
        "reservedHosts": ["nai.example.com"], "egressInterface": "eth0",
        "profiles": {
            "claude": {"profile": {"instanceId": "claude"}, "ip": "10.233.0.2", "gateway": "10.233.0.1",
                       "hostInterface": "t3h-claude", "preserveEgress": True},
            "codex": {"profile": {"instanceId": "codex"}, "ip": "10.233.0.6", "gateway": "10.233.0.5",
                      "hostInterface": "t3h-codex", "preserveEgress": False},
            "grok": {"profile": {"instanceId": "grok"}, "ip": "10.233.0.10", "gateway": "10.233.0.9",
                     "hostInterface": "t3h-grok", "preserveEgress": False},
        },
    }


class ServiceNetworkTests(unittest.TestCase):
    def setUp(self):
        self.config = configuration()
        self.empty = {"publications": [], "shares": []}

    def test_publication_resolves_own_private_address_and_preserves_other_routes(self):
        state = broker.mutate(self.config, self.empty, "codex", "publish",
                              {"name": "blog", "port": 3000, "hostname": "blog.example.com"}, 100)
        publication = state["publications"][0]
        self.assertEqual(publication["privateUrl"], "http://10.233.0.6:3000")
        self.assertEqual(publication["url"], "https://blog.example.com/")
        domains = broker.caddy_fragment(self.config, state)
        self.assertIn("blog.example.com {", domains)
        self.assertIn("reverse_proxy 10.233.0.6:3000", domains)
        self.assertNotIn("agent.example.com", domains)
        with self.assertRaises(ValueError):
            broker.mutate(self.config, state, "claude", "unpublish", {"id": publication["id"]}, 100)

    def test_rejects_arbitrary_upstreams_reserved_hosts_and_config_injection(self):
        for request in [{"name": "blog", "port": 3000, "upstream": "127.0.0.1:2019"},
                        {"name": "blog", "port": 3000, "hostname": "nai.example.com"},
                        {"name": "blog", "port": 3000, "hostname": "agent.example.com"},
                        {"name": "blog", "port": 3000},
                        {"name": "blog", "port": 3000, "hostname": "attacker.test"},
                        {"name": "blog\n}", "port": 3000}, {"name": "blog", "port": True},
                        {"name": "blog", "port": 443}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                broker.mutate(self.config, self.empty, "codex", "publish", request, 100)

    def test_dedicated_hostname_cannot_be_taken_over(self):
        request = {"name": "blog", "port": 3000, "hostname": "blog.example.com"}
        state = broker.mutate(self.config, self.empty, "codex", "publish", request, 100)
        with self.assertRaises(ValueError):
            broker.mutate(self.config, state, "grok", "publish", request, 100)

    def test_shared_service_visible_only_to_owner_and_recipient_until_expiry(self):
        state = broker.mutate(self.config, self.empty, "codex", "share",
                              {"port": 3000, "targetInstanceId": "claude", "durationMinutes": 1}, 100)
        self.assertEqual(len(broker.visible(self.config, state, "claude", 159)["shares"]), 1)
        self.assertEqual(broker.visible(self.config, state, "grok", 100)["shares"], [])
        self.assertEqual(broker.visible(self.config, state, "claude", 160)["shares"], [])
        self.assertIn("10.233.0.2 . 10.233.0.6 . 3000 timeout 60s", broker.host_rules(self.config, state, 100))
        self.assertNotIn("timeout", broker.host_rules(self.config, state, 160))
        with self.assertRaises(ValueError):
            broker.mutate(self.config, state, "claude", "unshare", {"id": state["shares"][0]["id"]}, 100)
        revoked = broker.mutate(self.config, state, "codex", "unshare", {"id": state["shares"][0]["id"]}, 100)
        self.assertEqual(revoked["shares"], [])

    def test_fixed_egress_has_no_host_nat_and_private_link_cannot_route_to_internet(self):
        host = broker.host_rules(self.config, self.empty, 100)
        self.assertNotIn("ip saddr 10.233.0.2 oifname", host)
        self.assertIn('iifname "t3h-claude" drop', host)
        claude = broker.namespace_rules(self.config, self.empty, "claude", 100)
        self.assertIn('oifname "t3net" drop', claude)
        self.assertNotIn('oifname "t3net" meta nfproto ipv4 accept', claude)
        self.assertNotIn("wg-claude", claude)


if __name__ == "__main__":
    unittest.main()
