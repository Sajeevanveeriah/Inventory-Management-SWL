"""Pricing rules for the competitor search prototype.

All money values use Decimal. The pricing rule is 30 percent markup on
cost, not gross margin. Competitor data may inform a recommendation but
must never automatically override the approved cost floor.
"""

import os
from decimal import ROUND_HALF_UP, Decimal

GST_RATE = Decimal(os.environ.get("GST_RATE", "0.10"))
ROUNDING_PLACES = int(os.environ.get("ROUNDING_PLACES", "2"))
MARKUP_RATE = Decimal("0.30")
RULE_VERSION = "rev01"

_QUANT = Decimal("1").scaleb(-ROUNDING_PLACES)


def round_money(value: Decimal) -> Decimal:
    """Round a monetary value after calculation, ROUND_HALF_UP."""
    return value.quantize(_QUANT, rounding=ROUND_HALF_UP)


def gst_divisor() -> Decimal:
    return Decimal("1") + GST_RATE


def to_ex_gst(price: Decimal, gst_basis: str) -> Decimal:
    """Normalise a price to ex GST. gst_basis must be inclusive or exclusive."""
    if gst_basis == "exclusive":
        return round_money(price)
    if gst_basis == "inclusive":
        return round_money(price / gst_divisor())
    raise ValueError("Unknown GST basis cannot be normalised")


def to_incl_gst(price_ex: Decimal) -> Decimal:
    return round_money(price_ex * gst_divisor())


def floor_ex_gst(cost_ex: Decimal) -> Decimal:
    """Cost floor: cost ex GST plus 30 percent markup on cost."""
    return round_money(cost_ex * (Decimal("1") + MARKUP_RATE))


def actual_markup(sell_ex: Decimal, cost_ex: Decimal) -> Decimal:
    """Markup on cost: (sell_ex - cost_ex) / cost_ex."""
    if cost_ex == 0:
        raise ValueError("Cost must be greater than zero to calculate markup")
    return ((sell_ex - cost_ex) / cost_ex).quantize(
        Decimal("0.0001"), rounding=ROUND_HALF_UP
    )
