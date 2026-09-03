import os
from pathlib import Path
from dotenv import load_dotenv

# Explicit path — works regardless of where the worker is launched from
load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env", override=True)

TOMTOM_API_KEY = os.getenv("TOMTOM_API_KEY", "")
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")
TRAFFIC_PROVIDER = os.getenv("TRAFFIC_PROVIDER", "tomtom").lower().strip()
MOCK_SERVER_URL = os.getenv("MOCK_SERVER_URL", "").rstrip("/")
DATABASE_URL = os.getenv("DATABASE_URL", "")

# Batch ML inference after each scoring cycle (local PC primary; disable in cloud cron).
ML_SCORING_ENABLED = os.getenv("ML_SCORING_ENABLED", "true").lower() in ("1", "true", "yes")
ML_MODELS_DIR = os.getenv("ML_MODELS_DIR", "frontend/api/ml_models")
