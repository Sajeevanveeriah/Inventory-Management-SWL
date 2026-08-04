"""Unit tests for pricing rules."""

from decimal import Decimal

from app.services import pricing


def test_floor_cost_100():
    assert pricing.floor_ex_gst(Decimal("100.00")) == Decimal("130.00")


def test_gst_inclusive_normalisation():
    assert pricing.to_ex_gst(Decimal("100.00"), "inclusive") == Decimal("90.91")


def test_gst_exclusive_passthrough():
    assert pricing.to_ex_gst(Decimal("90.91"), "exclusive") == Decimal("90.91")


def test_unknown_gst_basis_raises():
    import pytest

    with pytest.raises(ValueError):
        pricing.to_ex_gst(Decimal("100.00"), "unknown")


def test_actual_markup():
    assert pricing.actual_markup(Decimal("130.00"), Decimal("100.00")) == Decimal("0.3000")


def test_incl_gst_display():
    assert pricing.to_incl_gst(Decimal("90.91")) == Decimal("100.00")
