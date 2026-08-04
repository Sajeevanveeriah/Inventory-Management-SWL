"""Tests for the v2 Pricing Control Hub site. No network, no live URLs, no secrets."""

import re
from decimal import Decimal

import pytest

from app.services import competitor as competitor_service
from tests.conftest import make_observation

V2_ROUTES = [
    "/v2/dashboard",
    "/v2/products",
    "/v2/products/SWL-ABUS-55-40",
    "/v2/products/SWL-ABUS-55-40/competitor",
    "/v2/supplier-files",
    "/v2/supplier-offers",
    "/v2/pricing-rules",
    "/v2/bundles",
    "/v2/trade-tiers",
    "/v2/competitor/search",
    "/v2/exceptions",
    "/v2/approvals",
    "/v2/releases",
    "/v2/reconciliation",
    "/v2/audit",
    "/v2/settings",
    "/v2/help",
]


@pytest.mark.parametrize("route", V2_ROUTES)
def test_every_v2_route_returns_200_with_v2_layout(client, seeded, route):
    response = client.get(route)
    assert response.status_code == 200, route
    assert 'data-layout="v2"' in response.text, route


def test_legacy_route_remains_available(client, seeded):
    assert client.get("/ui/competitor-search").status_code == 200
    legacy = client.get("/legacy", follow_redirects=True)
    assert legacy.status_code == 200
    assert "Competitor Search" in legacy.text


def test_navigation_contains_links_to_all_v2_pages(client, seeded):
    html = client.get("/v2/dashboard").text
    nav_targets = [
        "/v2/dashboard", "/v2/products", "/v2/supplier-files", "/v2/supplier-offers",
        "/v2/pricing-rules", "/v2/bundles", "/v2/trade-tiers", "/v2/competitor/search",
        "/v2/exceptions", "/v2/approvals", "/v2/releases", "/v2/reconciliation",
        "/v2/audit", "/v2/settings", "/v2/help",
    ]
    for target in nav_targets:
        assert f'href="{target}"' in html, target


def test_dashboard_shows_not_authorised_banner(client, seeded):
    html = client.get("/v2/dashboard").text
    assert "Production write access is not authorised" in html


def test_product_list_shows_rows_and_filters(client, seeded):
    html = client.get("/v2/products").text
    assert "SWL-ABUS-55-40" in html
    assert "SWL-ABUS-55-40-HB" in html
    for filter_id in ["filter-q", "filter-category", "filter-brand", "filter-supplier",
                      "filter-active", "filter-exception", "filter-missing"]:
        assert filter_id in html
    filtered = client.get("/v2/products?missing_cost=1").text
    assert "SWL-NO-COST" in filtered
    assert ">SWL-ABUS-55-40<" not in filtered


def test_product_detail_shows_cost_and_markup(client, db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id)
    competitor_service.build_recommendation(db_session, "SWL-ABUS-55-40", strategy="MATCH")
    html = client.get("/v2/products/SWL-ABUS-55-40").text
    assert "60.00" in html
    assert "78.00" in html
    assert "markup" in html.lower()
    assert client.get("/v2/products/UNKNOWN-SKU").status_code == 404


def test_competitor_search_page_renders_and_api_returns_local_candidates(client, seeded):
    html = client.get("/v2/competitor/search").text
    assert "Search local competitor records" in html
    response = client.post(
        "/api/competitor/search",
        json={"internal_sku": "SWL-ABUS-55-40", "query": "ABUS"},
    )
    assert response.status_code == 200
    assert len(response.json()["candidates"]) >= 1


def test_observation_form_has_required_fields_and_validation(client, seeded):
    html = client.get("/v2/products/SWL-ABUS-55-40/competitor").text
    for field_id in ["obs-cp", "obs-price", "obs-gst", "obs-shipping-basis", "obs-stock",
                     "obs-url", "obs-confidence", "obs-reviewer", "obs-notes"]:
        assert f'id="{field_id}"' in html
    response = client.post(
        "/api/competitor/observations",
        json={"internal_sku": "SWL-ABUS-55-40"},
    )
    assert response.status_code == 422


def test_unknown_gst_rejected(client, seeded):
    response = client.post(
        "/api/competitor/observations",
        json={
            "internal_sku": "SWL-ABUS-55-40",
            "competitor_product_id": seeded["cp_approved"].id,
            "observed_at": "2026-08-04T00:00:00+00:00",
            "price": "100.00",
            "currency": "AUD",
            "gst_basis": "unknown",
            "stock_status": "in_stock",
            "source_url": "https://example.com/abus-55-40",
            "match_confidence": "high",
        },
    )
    assert response.status_code == 422


def test_low_confidence_excluded_from_automatic_recommendation(db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id, match_confidence="low")
    assert competitor_service.valid_accepted_observations(db_session, "SWL-ABUS-55-40") == []


def test_unapproved_source_rejected(client, seeded):
    response = client.post(
        "/api/competitor/observations",
        json={
            "internal_sku": "SWL-ABUS-55-40",
            "competitor_product_id": seeded["cp_unapproved"].id,
            "observed_at": "2026-08-04T00:00:00+00:00",
            "price": "100.00",
            "currency": "AUD",
            "gst_basis": "inclusive",
            "stock_status": "in_stock",
            "source_url": "https://example.com/other",
            "match_confidence": "high",
        },
    )
    assert response.status_code == 403


def test_below_floor_sets_release_blocked(db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id, internal_sku="SWL-ABUS-55-40-HB")
    result = competitor_service.build_recommendation(db_session, "SWL-ABUS-55-40-HB", strategy="MATCH")
    assert result["release_blocked"] is True
    assert result["exception_state"] == "COMPETITOR_BELOW_FLOOR"


def test_safe_match_produces_ok_recommendation(db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id)
    result = competitor_service.build_recommendation(db_session, "SWL-ABUS-55-40", strategy="MATCH")
    assert result["exception_state"] == "OK"
    assert result["recommended_ex_gst"] == Decimal("90.91")


def test_exception_queue_shows_below_floor(client, db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id, internal_sku="SWL-ABUS-55-40-HB")
    competitor_service.build_recommendation(db_session, "SWL-ABUS-55-40-HB", strategy="MATCH")
    html = client.get("/v2/exceptions").text
    assert "COMPETITOR_BELOW_FLOOR" in html
    assert "SWL-ABUS-55-40-HB" in html


def test_approvals_page_is_proposal_only(client, db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id)
    competitor_service.build_recommendation(db_session, "SWL-ABUS-55-40", strategy="MATCH")
    html = client.get("/v2/approvals").text
    assert "proposal" in html.lower()
    assert "There is no release action on this page" in html


def test_releases_page_read_only_not_authorised(client, seeded):
    html = client.get("/v2/releases").text
    assert "Production release is not authorised" in html
    assert "read only" in html.lower()


def test_audit_page_shows_events(client, db_session, seeded):
    client.post("/api/competitor/search", json={"internal_sku": "SWL-ABUS-55-40", "query": "ABUS"})
    html = client.get("/v2/audit").text
    assert "competitor_search" in html


def test_no_rendered_page_contains_secrets(client, db_session, seeded):
    secret_patterns = re.compile(
        r"(password\s*[:=])|(api[_-]?key\s*[:=])|(secret\s*[:=])|(token\s*[:=])|(BEGIN [A-Z]+ PRIVATE KEY)",
        re.IGNORECASE,
    )
    for route in V2_ROUTES:
        text = client.get(route).text
        assert not secret_patterns.search(text), route


def test_no_external_scripts_fonts_analytics_or_tracking(client, seeded):
    external = re.compile(
        r'(src|href)\s*=\s*["\']https?://', re.IGNORECASE
    )
    trackers = re.compile(
        r"(googletagmanager|google-analytics|gtag\(|analytics\.js|hotjar|segment\.com|"
        r"fonts\.googleapis|fonts\.gstatic|cdn\.|cdnjs|unpkg|jsdelivr|facebook\.net)",
        re.IGNORECASE,
    )
    for route in V2_ROUTES:
        text = client.get(route).text
        assert not external.search(text), route
        assert not trackers.search(text), route


def test_basic_accessibility_checks(client, db_session, seeded):
    for route in V2_ROUTES:
        html = client.get(route).text
        assert "<main" in html, route
        assert "Skip to main content" in html, route
        assert "<h1" in html, route
        h1_pos = html.find("<h1")
        first_h2 = html.find("<h2")
        if first_h2 != -1:
            assert h1_pos < first_h2, f"heading order wrong on {route}"
    # Every visible form input on the competitor page has an associated label
    html = client.get("/v2/products/SWL-ABUS-55-40/competitor").text
    input_ids = re.findall(r'<(?:input|select|textarea)[^>]*\bid="([a-z0-9-]+)"', html)
    for input_id in input_ids:
        assert f'for="{input_id}"' in html, f"missing label for {input_id}"
    # Form error messages are linked to fields
    assert 'aria-describedby="obs-price-error"' in html
    assert 'id="obs-price-error"' in html


def test_seed_is_idempotent_and_creates_required_records(db_session):
    from app.seed import seed

    first = seed(db_session)
    assert first["products"] == 2
    assert first["observations"] >= 3
    assert first.get("recommendations", 0) == 1
    assert first.get("audit_events", 0) == 1
    second = seed(db_session)
    assert second["products"] == 0
    assert second["observations"] == 0
    assert "recommendations" not in second
    assert "audit_events" not in second
