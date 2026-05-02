"""Taqeem automation-browser credentials: read from project `.env` only."""

import os
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(_ROOT / ".env")

TAQEEM_PRIMARY_LOGIN_ID = os.getenv("TAQEEM_PRIMARY_LOGIN_ID")
TAQEEM_PRIMARY_PASSWORD = os.getenv("TAQEEM_PRIMARY_PASSWORD")
