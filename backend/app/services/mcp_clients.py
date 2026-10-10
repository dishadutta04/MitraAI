from __future__ import annotations

from app.schemas import ProductOption


from app.services.catalog import listings


def search_products(item: str, quantity: int) -> list[ProductOption]:
    """Simulated Zepto + Amazon search over the demo catalogue."""
    return [
        ProductOption(
            vendor=listing.vendor,
            item_name=listing.name,
            pack=listing.pack,
            unit_price=listing.price,
            eta_minutes=listing.eta,
            in_stock=True,
            quantity_supported=max(1, quantity),
        )
        for listing in listings(item)
    ]
