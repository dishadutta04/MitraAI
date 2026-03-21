from __future__ import annotations

from app.schemas import ProductOption


class SimulatedZeptoMCP:
    def search(self, item: str, quantity: int) -> list[ProductOption]:
        base = [
            ProductOption(
                vendor="zepto",
                item_name=f"{item.title()} - Fresh Pack",
                unit_price=75,
                eta_minutes=12,
                in_stock=True,
                quantity_supported=max(1, quantity),
            ),
            ProductOption(
                vendor="zepto",
                item_name=f"{item.title()} - Value Pack",
                unit_price=68,
                eta_minutes=18,
                in_stock=True,
                quantity_supported=max(1, quantity),
            ),
        ]
        return base


class SimulatedAmazonMCP:
    def search(self, item: str, quantity: int) -> list[ProductOption]:
        base = [
            ProductOption(
                vendor="amazon",
                item_name=f"{item.title()} - Amazon Pantry",
                unit_price=65,
                eta_minutes=90,
                in_stock=True,
                quantity_supported=max(1, quantity),
            ),
            ProductOption(
                vendor="amazon",
                item_name=f"{item.title()} - Prime Fast",
                unit_price=72,
                eta_minutes=35,
                in_stock=True,
                quantity_supported=max(1, quantity),
            ),
        ]
        return base


def search_products(item: str, quantity: int) -> list[ProductOption]:
    zepto = SimulatedZeptoMCP().search(item, quantity)
    amazon = SimulatedAmazonMCP().search(item, quantity)
    return zepto + amazon
