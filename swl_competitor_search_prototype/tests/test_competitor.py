"""Tests for the competitor observation and recommendation module."""

from decimal import Decimal

from app.models import AuditEvent, CompetitiveRecommendation
from app.services import competitor as competitor_service
from tests.conftest import make_observation


def test_recommendation_safe_match(db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id)
    result = competitor_service.build_recommendation(
        db_session, "SWL-ABUS-55-40", strategy="MATCH"
    )
    assert result["selected_competitor_ex_gst"] == Decimal("90.91")
    assert result["recommended_ex_gst"] == Decimal("90.91")
    assert result["exception_state"] == "OK"
    assert result["release_blocked"] is False


def test_recommendation_floor_block(db_session, seeded):
    make_observation(
        db_session, seeded["cp_approved"].id, internal_sku="SWL-ABUS-55-40-HB"
    )
    result = competitor_service.build_recommendation(
        db_session, "SWL-ABUS-55-40-HB", strategy="MATCH"
    )
    assert result["floor_ex_gst"] == Decimal("97.50")
    assert result["selected_competitor_ex_gst"] == Decimal("90.91")
    assert result["recommended_ex_gst"] == Decimal("97.50")
    assert result["exception_state"] == "COMPETITOR_BELOW_FLOOR"
    assert result["release_blocked"] is True


def test_unknown_gst_quarantine(db_session, seeded):
    obs = make_observation(db_session, seeded["cp_approved"].id, gst_basis="unknown")
    reason = competitor_service.observation_exclusion_reason(db_session, obs)
    assert reason == "unknown GST basis"
    assert competitor_service.valid_accepted_observations(db_session, "SWL-ABUS-55-40") == []
    result = competitor_service.build_recommendation(
        db_session, "SWL-ABUS-55-40", strategy="MATCH"
    )
    assert result["exception_state"] == "NO_VALID_OBSERVATION"
    assert result["release_blocked"] is True


def test_low_confidence_excluded(db_session, seeded):
    obs = make_observation(db_session, seeded["cp_approved"].id, match_confidence="low")
    reason = competitor_service.observation_exclusion_reason(db_session, obs)
    assert reason == "low match confidence"
    assert competitor_service.valid_accepted_observations(db_session, "SWL-ABUS-55-40") == []


def test_unapproved_source_rejected(client, db_session, seeded):
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
            "source_url": "https://example.com/other-abus-55-40",
            "match_confidence": "high",
        },
    )
    assert response.status_code == 403


def test_missing_cost_exception(db_session, seeded):
    result = competitor_service.build_recommendation(
        db_session, "SWL-NO-COST", strategy="MATCH"
    )
    assert result["exception_state"] == "MISSING_COST"
    assert result["release_blocked"] is True
    assert result["recommended_ex_gst"] is None


def test_audit_event_created(client, db_session, seeded):
    response = client.post(
        "/api/competitor/observations",
        json={
            "internal_sku": "SWL-ABUS-55-40",
            "competitor_product_id": seeded["cp_approved"].id,
            "observed_at": "2026-08-04T00:00:00+00:00",
            "price": "100.00",
            "currency": "AUD",
            "gst_basis": "inclusive",
            "stock_status": "in_stock",
            "source_url": "https://example.com/abus-55-40",
            "match_confidence": "high",
            "reviewer": "test_reviewer",
        },
    )
    assert response.status_code == 201
    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "observation_created")
        .all()
    )
    assert len(events) == 1
    assert events[0].entity_id == str(response.json()["id"])


def test_recommendation_created(client, db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id)
    response = client.post(
        "/api/competitor/recommendations",
        json={"internal_sku": "SWL-ABUS-55-40", "strategy": "MATCH"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["recommended_ex_gst"] == "90.91"
    assert body["stored"] is True
    stored = db_session.query(CompetitiveRecommendation).all()
    assert len(stored) == 1
    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "recommendation_created")
        .all()
    )
    assert len(events) == 1


def test_unknown_gst_rejected_by_api(client, seeded):
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


def test_non_aud_rejected_by_api(client, seeded):
    response = client.post(
        "/api/competitor/observations",
        json={
            "internal_sku": "SWL-ABUS-55-40",
            "competitor_product_id": seeded["cp_approved"].id,
            "observed_at": "2026-08-04T00:00:00+00:00",
            "price": "100.00",
            "currency": "USD",
            "gst_basis": "inclusive",
            "stock_status": "in_stock",
            "source_url": "https://example.com/abus-55-40",
            "match_confidence": "high",
        },
    )
    assert response.status_code == 422


def test_stale_observation_excluded(db_session, seeded):
    from datetime import datetime, timezone

    obs = make_observation(
        db_session,
        seeded["cp_approved"].id,
        observed_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )
    reason = competitor_service.observation_exclusion_reason(db_session, obs)
    assert reason == "observation is stale"


def test_undercut_never_below_floor(db_session, seeded):
    make_observation(db_session, seeded["cp_approved"].id)
    result = competitor_service.build_recommendation(
        db_session,
        "SWL-ABUS-55-40",
        strategy="UNDERCUT_AMOUNT",
        undercut_amount=Decimal("50.00"),
    )
    assert result["recommended_ex_gst"] == Decimal("78.00")
    assert result["exception_state"] == "COMPETITOR_BELOW_FLOOR"
    assert result["release_blocked"] is True


def test_search_returns_candidates(client, seeded):
    response = client.post(
        "/api/competitor/search",
        json={"internal_sku": "SWL-ABUS-55-40", "query": "ABUS 55/40"},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["candidates"]) >= 1
    ids = {c["competitor_product_id"] for c in body["candidates"]}
    assert seeded["cp_approved"].id in ids


def test_health_and_ui(client):
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["production_write_authorised"] is False
    ui = client.get("/ui/competitor-search")
    assert ui.status_code == 200
    assert "Competitor Search" in ui.text
    assert "release" in ui.text.lower()
