import os
import unittest

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")

from app.services.ingestion import _dbt_resources, _equal_allocation_weights, _secret_env_prefix


class IngestionTests(unittest.TestCase):
    def test_dbt_resources_include_supported_physical_resources(self):
        payload = {
            "nodes": {
                "model.pkg.orders": {"resource_type": "model", "name": "orders"},
                "seed.pkg.states": {"resource_type": "seed", "name": "states"},
                "test.pkg.orders": {"resource_type": "test", "name": "orders_unique"},
            },
            "sources": {
                "source.pkg.raw.orders": {"resource_type": "source", "name": "orders"}
            },
        }
        resources = _dbt_resources(payload)
        self.assertEqual(
            set(resources),
            {"model.pkg.orders", "seed.pkg.states", "source.pkg.raw.orders"},
        )

    def test_secret_reference_maps_to_bounded_environment_prefix(self):
        self.assertEqual(_secret_env_prefix("customer-one"), "SNOWFLAKE_SECRET_CUSTOMER_ONE_")

    def test_equal_allocation_weights_conserve_credits(self):
        weights = _equal_allocation_weights(3)
        self.assertEqual(sum(weights), 1)
        self.assertEqual(len(weights), 3)


if __name__ == "__main__":
    unittest.main()
