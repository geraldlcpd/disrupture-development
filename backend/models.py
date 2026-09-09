"""
SQLAlchemy ORM Models — Neon PostgreSQL Edition
Migrated from Oracle ATP (SDO_GEOMETRY) to standard PostgreSQL with flat lat/lon columns.
Schema aligns with the new Neon schema: zones, zone_status, crowd_snapshots,
traffic_snapshots, weather_snapshots, earthquake_events, risk_alerts, poi_master,
jabodetabek_waterways.
"""

from sqlalchemy import (
    Column, Integer, String, Float, Boolean, Text,
    DateTime, Numeric, BigInteger, ForeignKey, Double
)
from sqlalchemy.sql import func
from database import Base


class Zone(Base):
    __tablename__ = "zones"

    zone_id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    radius_m = Column(Integer, nullable=False)
    capacity = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.current_timestamp())
    historical_flood_vulnerability = Column(Numeric(5, 2), default=0.50)
    traffic_speed_baseline = Column(Numeric(6, 2), default=40.00)


class ZoneStatus(Base):
    __tablename__ = "zone_status"

    zone_id = Column(Integer, ForeignKey("zones.zone_id"), primary_key=True)
    traffic_score = Column(Numeric(5, 2), nullable=True)
    weather_score = Column(Numeric(5, 2), nullable=True)
    crowd_score = Column(Numeric(5, 2), nullable=True)
    earthquake_score = Column(Numeric(5, 2), nullable=True)
    waterway_score = Column(Numeric(5, 2), nullable=True)
    overall_risk_score = Column(Numeric(5, 2), nullable=True)
    last_updated = Column(DateTime, nullable=True)
    dominant_risk = Column(String(50), nullable=True)
    recommended_action = Column(Text, nullable=True)


class TrafficSnapshot(Base):
    __tablename__ = "traffic_snapshots"

    snapshot_id = Column(BigInteger, primary_key=True, autoincrement=True)
    zone_id = Column(Integer, ForeignKey("zones.zone_id"), nullable=True)
    timestamp = Column(DateTime, nullable=False)
    speed = Column(Numeric(6, 2), nullable=True)
    congestion = Column(Numeric(6, 2), nullable=True)
    travel_time = Column(Numeric(8, 2), nullable=True)


class WeatherSnapshot(Base):
    __tablename__ = "weather_snapshots"

    snapshot_id = Column(BigInteger, primary_key=True, autoincrement=True)
    zone_id = Column(Integer, ForeignKey("zones.zone_id"), nullable=True)
    timestamp = Column(DateTime, nullable=False)
    rainfall = Column(Numeric(8, 2), nullable=True)
    humidity = Column(Numeric(5, 2), nullable=True)
    wind_speed = Column(Numeric(6, 2), nullable=True)


class CrowdSnapshot(Base):
    __tablename__ = "crowd_snapshots"

    snapshot_id = Column(BigInteger, primary_key=True, autoincrement=True)
    zone_id = Column(Integer, ForeignKey("zones.zone_id"), nullable=True)
    timestamp = Column(DateTime, nullable=False)
    crowd_score = Column(Numeric(5, 2), nullable=True)
    poi_count = Column(Integer, nullable=True)
    hazard_count = Column(Integer, nullable=True)
    confidence_score = Column(Numeric(5, 2), nullable=True)


class PoiCrowdStatus(Base):
    """Per-POI crowd score, recomputed every scoring cycle."""
    __tablename__ = "poi_crowd_status"

    poi_id = Column(String(100), ForeignKey("poi_master.poi_id", ondelete="CASCADE"), primary_key=True)
    crowd_score = Column(Numeric(5, 2), nullable=True)
    confidence_score = Column(Numeric(5, 2), nullable=True)
    last_updated = Column(DateTime, nullable=True)


class EarthquakeEvent(Base):
    __tablename__ = "earthquake_events"

    event_id = Column(String(100), primary_key=True)
    magnitude = Column(Numeric(4, 2), nullable=True)
    depth_km = Column(Numeric(6, 2), nullable=True)
    latitude = Column(Double, nullable=True)
    longitude = Column(Double, nullable=True)
    event_timestamp = Column(DateTime, nullable=True)
    location = Column(Text, nullable=True)
    impact_radius_km = Column(Numeric(8, 2), nullable=True)


class RiskAlert(Base):
    __tablename__ = "risk_alerts"

    alert_id = Column(BigInteger, primary_key=True, autoincrement=True)
    zone_id = Column(Integer, ForeignKey("zones.zone_id"), nullable=True)
    disruption_type = Column(String(50), nullable=True)
    severity = Column(String(20), nullable=True)
    alert_timestamp = Column(DateTime, nullable=True)
    message = Column(Text, nullable=True)
    status = Column(String(20), default="OPEN")
    probability_percentage = Column(Numeric(5, 2), nullable=True)
    estimated_time_to_peak = Column(DateTime, nullable=True)
    estimated_resolution_at = Column(DateTime, nullable=True)
    resolution_confidence = Column(Numeric(5, 2), nullable=True)


class PoiMaster(Base):
    __tablename__ = "poi_master"

    poi_id = Column(String(100), primary_key=True)
    name = Column(String(255), nullable=True)
    category = Column(String(100), nullable=True)
    latitude = Column(Double, nullable=True)
    longitude = Column(Double, nullable=True)
    zone_id = Column(Integer, ForeignKey("zones.zone_id"), nullable=True)
    source = Column(String(50), nullable=True)
    last_refresh = Column(DateTime, nullable=True)
    is_safe_zone = Column(Boolean, default=False)


class JabodetabekWaterway(Base):
    __tablename__ = "jabodetabek_waterways"

    hyriv_id = Column(BigInteger, primary_key=True)
    name = Column(String(100), nullable=True)
    next_down = Column(BigInteger)
    main_riv = Column(BigInteger)
    length_km = Column(Float)
    dist_dn_km = Column(Float)
    dist_up_km = Column(Float)
    catch_skm = Column(Float)
    upland_skm = Column(Float)
    dis_av_cms = Column(Float)
    coordinates_json = Column(Text)
    current_discharge_cms = Column(Float)
    discharge_ratio = Column(Float)
    alert_level = Column(String(20))
    last_updated = Column(DateTime)
