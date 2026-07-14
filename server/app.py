from __future__ import annotations

import logging
import os
import secrets
import sqlite3
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.middleware.sessions import SessionMiddleware


LOGGER = logging.getLogger("okimap.collab")
BASE_DIR = Path(__file__).resolve().parent
API_PREFIX = "/api"
DISCORD_API = "https://discord.com/api/v10"
DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize"


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        self.database_path = Path(
            os.getenv("OKIMAP_DATABASE_PATH", str(BASE_DIR / "data" / "okimap.db"))
        )
        self.frontend_url = os.getenv(
            "OKIMAP_FRONTEND_URL", "https://okimap.wplaceoki.com/"
        ).rstrip("/") + "/"
        origins = os.getenv(
            "OKIMAP_ALLOWED_ORIGINS", "https://okimap.wplaceoki.com"
        )
        self.allowed_origins = [item.strip().rstrip("/") for item in origins.split(",") if item.strip()]
        self.discord_client_id = os.getenv("DISCORD_CLIENT_ID", "")
        self.discord_client_secret = os.getenv("DISCORD_CLIENT_SECRET", "")
        self.discord_redirect_uri = os.getenv(
            "DISCORD_REDIRECT_URI",
            "https://okimap-api.wplaceoki.com/api/auth/discord/callback",
        )
        self.session_secret = os.getenv("OKIMAP_SESSION_SECRET", "development-only-change-me")
        self.secure_cookies = env_bool("OKIMAP_SECURE_COOKIES", True)
        self.cookie_path = os.getenv("OKIMAP_COOKIE_PATH", "/api")
        admin_ids = os.getenv("OKIMAP_ADMIN_DISCORD_IDS", "")
        self.admin_ids = {item.strip() for item in admin_ids.split(",") if item.strip()}
        self.environment = os.getenv("OKIMAP_ENVIRONMENT", "development").lower()

        if self.environment == "production":
            missing = [
                name
                for name, value in (
                    ("DISCORD_CLIENT_ID", self.discord_client_id),
                    ("DISCORD_CLIENT_SECRET", self.discord_client_secret),
                    ("OKIMAP_SESSION_SECRET", os.getenv("OKIMAP_SESSION_SECRET", "")),
                )
                if not value
            ]
            if missing:
                raise RuntimeError(f"Missing production settings: {', '.join(missing)}")
            if len(self.session_secret) < 32:
                raise RuntimeError("OKIMAP_SESSION_SECRET must be at least 32 characters")


settings = Settings()
app = FastAPI(title="OkiMAP Collaboration API", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    session_cookie="okimap_session",
    max_age=60 * 60 * 24 * 7,
    path=settings.cookie_path,
    same_site="lax",
    https_only=settings.secure_cookies,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect_db() -> sqlite3.Connection:
    connection = sqlite3.connect(settings.database_path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("pragma foreign_keys = on")
    connection.execute("pragma busy_timeout = 5000")
    return connection


def initialize_database() -> None:
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    schema = (BASE_DIR / "schema.sql").read_text(encoding="utf-8")
    with closing(connect_db()) as connection:
        connection.execute("pragma journal_mode = wal")
        connection.executescript(schema)
        connection.commit()


@app.on_event("startup")
def startup() -> None:
    initialize_database()


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Cache-Control"] = "no-store"
    return response


def require_allowed_origin(request: Request) -> None:
    origin = request.headers.get("origin", "").rstrip("/")
    if origin not in settings.allowed_origins:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid origin")


def get_user_by_id(discord_id: str | None) -> dict | None:
    if not discord_id:
        return None
    with closing(connect_db()) as connection:
        row = connection.execute(
            "select discord_id, display_name, avatar_url, is_admin from users where discord_id = ?",
            (discord_id,),
        ).fetchone()
    if not row:
        return None
    return {
        "id": row["discord_id"],
        "display_name": row["display_name"],
        "avatar_url": row["avatar_url"],
        "is_admin": bool(row["is_admin"]),
    }


def optional_user(request: Request) -> dict | None:
    return get_user_by_id(request.session.get("discord_id"))


def require_user(request: Request) -> dict:
    user = optional_user(request)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Login required")
    return user


def require_mutating_user(request: Request) -> dict:
    require_allowed_origin(request)
    return require_user(request)


RateKey = tuple[str, str]
rate_windows: dict[RateKey, deque[float]] = defaultdict(deque)
rate_lock = threading.Lock()


def enforce_rate_limit(user_id: str, action: str, limit: int, window_seconds: int) -> None:
    now = time.monotonic()
    key = (user_id, action)
    with rate_lock:
        entries = rate_windows[key]
        while entries and entries[0] <= now - window_seconds:
            entries.popleft()
        if len(entries) >= limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests",
            )
        entries.append(now)


Kind = Literal["plan", "working", "report", "question"]
PinStatus = Literal["open", "in_progress", "review", "done", "on_hold"]


class PinPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    x: int = Field(ge=0, le=14999)
    y: int = Field(ge=0, le=10999)
    kind: Kind
    status: PinStatus = "open"
    title: str = Field(min_length=1, max_length=80)
    body: str = Field(default="", max_length=2000)
    related_url: str | None = Field(default=None, max_length=500)

    @field_validator("related_url")
    @classmethod
    def validate_related_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("related_url must be an http(s) URL")
        return value


class CommentPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    body: str = Field(min_length=1, max_length=1000)


def serialize_author(row: sqlite3.Row) -> dict:
    return {
        "id": row["author_id"],
        "display_name": row["author_name"],
        "avatar_url": row["author_avatar"],
        "is_admin": bool(row["author_is_admin"]),
    }


def serialize_pin(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "x": row["x"],
        "y": row["y"],
        "kind": row["kind"],
        "status": row["status"],
        "title": row["title"],
        "body": row["body"],
        "related_url": row["related_url"],
        "author_id": row["author_id"],
        "author": serialize_author(row),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "comment_count": row["comment_count"] if "comment_count" in row.keys() else 0,
    }


def serialize_comment(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "pin_id": row["pin_id"],
        "body": row["body"],
        "author_id": row["author_id"],
        "author": serialize_author(row),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


PIN_SELECT = """
select p.*,
       u.display_name as author_name,
       u.avatar_url as author_avatar,
       u.is_admin as author_is_admin,
       (select count(*) from comments c where c.pin_id = p.id and c.deleted_at is null) as comment_count
from pins p
join users u on u.discord_id = p.author_id
"""

COMMENT_SELECT = """
select c.*,
       u.display_name as author_name,
       u.avatar_url as author_avatar,
       u.is_admin as author_is_admin
from comments c
join users u on u.discord_id = c.author_id
"""


@app.get(f"{API_PREFIX}/health")
def health() -> dict:
    return {"ok": True}


@app.get(f"{API_PREFIX}/auth/discord/login")
def discord_login(request: Request):
    if not settings.discord_client_id or not settings.discord_client_secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Discord OAuth is not configured")
    oauth_state = secrets.token_urlsafe(32)
    request.session["oauth_state"] = oauth_state
    query = urlencode(
        {
            "client_id": settings.discord_client_id,
            "redirect_uri": settings.discord_redirect_uri,
            "response_type": "code",
            "scope": "identify",
            "state": oauth_state,
            "prompt": "consent",
        }
    )
    return RedirectResponse(f"{DISCORD_AUTHORIZE}?{query}", status_code=302)


@app.get(f"{API_PREFIX}/auth/discord/callback")
async def discord_callback(request: Request, code: str = "", state: str = ""):
    expected_state = request.session.pop("oauth_state", None)
    if not code or not state or not expected_state or not secrets.compare_digest(state, expected_state):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state")

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            token_response = await client.post(
                f"{DISCORD_API}/oauth2/token",
                data={
                    "client_id": settings.discord_client_id,
                    "client_secret": settings.discord_client_secret,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": settings.discord_redirect_uri,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if token_response.is_error:
                LOGGER.warning("Discord token exchange failed: %s", token_response.status_code)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Discord token exchange failed",
                )
            token = token_response.json().get("access_token")
            if not token:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Discord did not return an access token",
                )
            user_response = await client.get(
                f"{DISCORD_API}/users/@me",
                headers={"Authorization": f"Bearer {token}"},
            )
            if user_response.is_error:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Discord user lookup failed",
                )
            discord_user = user_response.json()
    except httpx.RequestError as error:
        LOGGER.warning("Discord OAuth request failed: %s", error)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not connect to Discord",
        ) from error

    discord_id = str(discord_user["id"])
    display_name = (
        discord_user.get("global_name") or discord_user.get("username") or "Discord user"
    )[:80]
    avatar_hash = discord_user.get("avatar")
    avatar_url = (
        f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.png?size=128"
        if avatar_hash
        else None
    )
    is_admin = int(discord_id in settings.admin_ids)
    timestamp = now_iso()
    with closing(connect_db()) as connection:
        connection.execute(
            """
            insert into users (discord_id, display_name, avatar_url, is_admin, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)
            on conflict(discord_id) do update set
              display_name = excluded.display_name,
              avatar_url = excluded.avatar_url,
              is_admin = excluded.is_admin,
              updated_at = excluded.updated_at
            """,
            (discord_id, display_name, avatar_url, is_admin, timestamp, timestamp),
        )
        connection.commit()

    request.session.clear()
    request.session["discord_id"] = discord_id
    return RedirectResponse(f"{settings.frontend_url}?panel=pins", status_code=302)


@app.get(f"{API_PREFIX}/auth/session")
def auth_session(request: Request) -> dict:
    return {"user": optional_user(request)}


@app.post(f"{API_PREFIX}/auth/logout", status_code=204)
def auth_logout(request: Request):
    require_allowed_origin(request)
    request.session.clear()
    return Response(status_code=204)


@app.get(f"{API_PREFIX}/pins")
def list_pins() -> list[dict]:
    with closing(connect_db()) as connection:
        rows = connection.execute(
            PIN_SELECT + " where p.deleted_at is null order by p.updated_at desc limit 1000"
        ).fetchall()
    return [serialize_pin(row) for row in rows]


@app.post(f"{API_PREFIX}/pins", status_code=201)
def create_pin(payload: PinPayload, user: Annotated[dict, Depends(require_mutating_user)]) -> dict:
    enforce_rate_limit(user["id"], "create_pin", 10, 300)
    pin_id = str(uuid.uuid4())
    timestamp = now_iso()
    with closing(connect_db()) as connection:
        connection.execute(
            """
            insert into pins
              (id, x, y, kind, status, title, body, related_url, author_id, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                pin_id, payload.x, payload.y, payload.kind, payload.status, payload.title,
                payload.body, payload.related_url, user["id"], timestamp, timestamp,
            ),
        )
        connection.commit()
        row = connection.execute(PIN_SELECT + " where p.id = ?", (pin_id,)).fetchone()
    return serialize_pin(row)


def get_active_pin(connection: sqlite3.Connection, pin_id: str) -> sqlite3.Row:
    row = connection.execute(
        "select * from pins where id = ? and deleted_at is null", (pin_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pin not found")
    return row


def ensure_owner_or_admin(author_id: str, user: dict) -> None:
    if author_id != user["id"] and not user["is_admin"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")


@app.patch(f"{API_PREFIX}/pins/{{pin_id}}")
def update_pin(
    pin_id: str,
    payload: PinPayload,
    user: Annotated[dict, Depends(require_mutating_user)],
) -> dict:
    with closing(connect_db()) as connection:
        pin = get_active_pin(connection, pin_id)
        ensure_owner_or_admin(pin["author_id"], user)
        connection.execute(
            """
            update pins set x = ?, y = ?, kind = ?, status = ?, title = ?, body = ?,
              related_url = ?, updated_at = ? where id = ?
            """,
            (
                payload.x, payload.y, payload.kind, payload.status, payload.title,
                payload.body, payload.related_url, now_iso(), pin_id,
            ),
        )
        connection.commit()
        row = connection.execute(PIN_SELECT + " where p.id = ?", (pin_id,)).fetchone()
    return serialize_pin(row)


@app.delete(f"{API_PREFIX}/pins/{{pin_id}}", status_code=204)
def delete_pin(pin_id: str, user: Annotated[dict, Depends(require_mutating_user)]):
    with closing(connect_db()) as connection:
        pin = get_active_pin(connection, pin_id)
        ensure_owner_or_admin(pin["author_id"], user)
        timestamp = now_iso()
        connection.execute(
            "update pins set deleted_at = ?, updated_at = ? where id = ?",
            (timestamp, timestamp, pin_id),
        )
        connection.commit()
    return Response(status_code=204)


@app.get(f"{API_PREFIX}/pins/{{pin_id}}/comments")
def list_comments(pin_id: str) -> list[dict]:
    with closing(connect_db()) as connection:
        get_active_pin(connection, pin_id)
        rows = connection.execute(
            COMMENT_SELECT
            + " where c.pin_id = ? and c.deleted_at is null order by c.created_at asc",
            (pin_id,),
        ).fetchall()
    return [serialize_comment(row) for row in rows]


@app.post(f"{API_PREFIX}/pins/{{pin_id}}/comments", status_code=201)
def create_comment(
    pin_id: str,
    payload: CommentPayload,
    user: Annotated[dict, Depends(require_mutating_user)],
) -> dict:
    enforce_rate_limit(user["id"], "create_comment", 30, 300)
    comment_id = str(uuid.uuid4())
    timestamp = now_iso()
    with closing(connect_db()) as connection:
        get_active_pin(connection, pin_id)
        connection.execute(
            """
            insert into comments (id, pin_id, body, author_id, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)
            """,
            (comment_id, pin_id, payload.body, user["id"], timestamp, timestamp),
        )
        connection.commit()
        row = connection.execute(COMMENT_SELECT + " where c.id = ?", (comment_id,)).fetchone()
    return serialize_comment(row)


def get_active_comment(connection: sqlite3.Connection, comment_id: str) -> sqlite3.Row:
    row = connection.execute(
        "select * from comments where id = ? and deleted_at is null", (comment_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found")
    return row


@app.patch(f"{API_PREFIX}/comments/{{comment_id}}")
def update_comment(
    comment_id: str,
    payload: CommentPayload,
    user: Annotated[dict, Depends(require_mutating_user)],
) -> dict:
    with closing(connect_db()) as connection:
        comment = get_active_comment(connection, comment_id)
        ensure_owner_or_admin(comment["author_id"], user)
        connection.execute(
            "update comments set body = ?, updated_at = ? where id = ?",
            (payload.body, now_iso(), comment_id),
        )
        connection.commit()
        row = connection.execute(COMMENT_SELECT + " where c.id = ?", (comment_id,)).fetchone()
    return serialize_comment(row)


@app.delete(f"{API_PREFIX}/comments/{{comment_id}}", status_code=204)
def delete_comment(
    comment_id: str,
    user: Annotated[dict, Depends(require_mutating_user)],
):
    with closing(connect_db()) as connection:
        comment = get_active_comment(connection, comment_id)
        ensure_owner_or_admin(comment["author_id"], user)
        timestamp = now_iso()
        connection.execute(
            "update comments set deleted_at = ?, updated_at = ? where id = ?",
            (timestamp, timestamp, comment_id),
        )
        connection.commit()
    return Response(status_code=204)
