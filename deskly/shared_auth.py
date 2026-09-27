"""Private local credentials and revocable sessions for the shared workspace Web."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import stat
import time
from pathlib import Path
from threading import RLock
from uuid import uuid4

SHARED_SESSION_COOKIE_NAME = "deskly_shared_session"
SESSION_TTL_SECONDS = 30 * 60
MAX_SESSIONS = 256
_SCRYPT_N = 1 << 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_LOGIN_PATTERN = re.compile(r"[a-z][a-z0-9._-]{2,63}\Z")


class CredentialStoreError(ValueError):
    """The private credential store is missing, unsafe, or malformed."""


class LocalCredentialStore:
    """Explicitly initialized credential DB; member grants live in the workspace DB."""

    def __init__(self, path: Path):
        if not path.is_absolute():
            raise CredentialStoreError("credential path must be absolute")
        self.path = path
        self._check_file()

    @classmethod
    def initialize(cls, path: Path) -> LocalCredentialStore:
        if not path.is_absolute() or not path.parent.is_dir():
            raise CredentialStoreError("credential parent must already exist")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            store = cls(path)
            with store._connect() as db:
                db.execute("""CREATE TABLE accounts (
                    subject TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE,
                    salt BLOB NOT NULL, password_hash BLOB NOT NULL,
                    active INTEGER NOT NULL CHECK(active IN (0,1)),
                    revision INTEGER NOT NULL)""")
            return store
        except (FileExistsError, OSError, sqlite3.Error) as exc:
            raise CredentialStoreError("credential store could not be initialized") from exc

    def _check_file(self) -> None:
        try:
            mode = self.path.lstat().st_mode
            if not stat.S_ISREG(mode) or (os.name != "nt" and mode & 0o077):
                raise CredentialStoreError("credential store permissions are unsafe")
        except OSError as exc:
            raise CredentialStoreError("credential store is unavailable") from exc

    def _connect(self) -> sqlite3.Connection:
        self._check_file()
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA busy_timeout=5000")
        return db

    @staticmethod
    def _validate_login(login: str) -> str:
        if not isinstance(login, str) or _LOGIN_PATTERN.fullmatch(login) is None:
            raise CredentialStoreError("invalid login")
        return login

    @staticmethod
    def _validate_password(password: str) -> bytes:
        if not isinstance(password, str) or not 16 <= len(password) <= 1024 or any(
            ord(char) < 0x20 or 0x7f <= ord(char) <= 0x9f for char in password
        ):
            raise CredentialStoreError("invalid password")
        return password.encode("utf-8")

    @staticmethod
    def _hash(password: bytes, salt: bytes) -> bytes:
        return hashlib.scrypt(password, salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)

    def create_account(self, login: str, password: str) -> str:
        """Operator-only bootstrap. Never call through an HTTP route."""
        login = self._validate_login(login)
        password_bytes = self._validate_password(password)
        subject = str(uuid4())
        salt = secrets.token_bytes(32)
        digest = self._hash(password_bytes, salt)
        try:
            with self._connect() as db:
                db.execute("INSERT INTO accounts VALUES (?, ?, ?, ?, 1, 1)",
                           (subject, login, salt, digest))
        except sqlite3.Error as exc:
            raise CredentialStoreError("account could not be created") from exc
        return subject

    def change_password(self, subject: str, password: str) -> None:
        """Password rotation revokes every existing session for this account."""
        password_bytes = self._validate_password(password)
        salt = secrets.token_bytes(32)
        digest = self._hash(password_bytes, salt)
        with self._connect() as db:
            changed = db.execute("""UPDATE accounts SET salt=?,password_hash=?,revision=revision+1
                WHERE subject=? AND active=1""", (salt, digest, subject)).rowcount
        if changed != 1:
            raise CredentialStoreError("account is unavailable")

    def deactivate(self, subject: str) -> None:
        """Credential revocation takes effect on the next request."""
        with self._connect() as db:
            changed = db.execute("""UPDATE accounts SET active=0,revision=revision+1
                WHERE subject=? AND active=1""", (subject,)).rowcount
        if changed != 1:
            raise CredentialStoreError("account is unavailable")

    def authenticate(self, login: str, password: str) -> tuple[str, int] | None:
        try:
            login = self._validate_login(login)
            password_bytes = self._validate_password(password)
        except CredentialStoreError:
            return None
        with self._connect() as db:
            row = db.execute("""SELECT subject,salt,password_hash,active,revision
                FROM accounts WHERE login=?""", (login,)).fetchone()
        # Spend the same KDF work for unknown accounts to avoid an easy username oracle.
        salt = row[1] if row is not None else bytes(32)
        digest = self._hash(password_bytes, salt)
        if row is None or not row[3] or not hmac.compare_digest(digest, row[2]):
            return None
        return str(row[0]), int(row[4])

    def is_current(self, subject: str, revision: int) -> bool:
        with self._connect() as db:
            row = db.execute("SELECT active,revision FROM accounts WHERE subject=?",
                             (subject,)).fetchone()
        return row is not None and bool(row[0]) and row[1] == revision

    def active_subjects(self) -> tuple[str, ...]:
        """Readiness probe input; never returns password material."""
        with self._connect() as db:
            rows = db.execute("SELECT subject FROM accounts WHERE active=1").fetchall()
        return tuple(str(row[0]) for row in rows)


class SharedSessions:
    """In-memory opaque sessions with persistent account-revision revocation."""

    def __init__(self, accounts: LocalCredentialStore):
        self.accounts = accounts
        self._sessions: dict[str, tuple[str, int, float]] = {}
        self._failed: dict[str, tuple[int, float]] = {}
        self._lock = RLock()

    def allowed_login(self, address: str) -> bool:
        with self._lock:
            failures, until = self._failed.get(address, (0, 0.0))
            if until <= time.monotonic():
                self._failed.pop(address, None)
                return True
            return failures < 5

    def record_failure(self, address: str) -> None:
        now = time.monotonic()
        with self._lock:
            failures, until = self._failed.get(address, (0, 0.0))
            if until <= now:
                failures = 0
            self._failed[address] = (failures + 1, now + 60)
            if len(self._failed) > 1024:
                oldest = min(self._failed, key=lambda key: self._failed[key][1])
                self._failed.pop(oldest, None)

    def record_success(self, address: str) -> None:
        with self._lock:
            self._failed.pop(address, None)

    def create(self, subject: str, revision: int) -> str:
        now = time.monotonic()
        with self._lock:
            self._sessions = {key: value for key, value in self._sessions.items()
                              if value[2] > now}
            if len(self._sessions) >= MAX_SESSIONS:
                oldest = min(self._sessions, key=lambda key: self._sessions[key][2])
                self._sessions.pop(oldest, None)
            token = secrets.token_urlsafe(32)
            self._sessions[token] = (subject, revision, now + SESSION_TTL_SECONDS)
            return token

    def subject(self, token: str) -> str | None:
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return None
            if session[2] <= time.monotonic():
                self._sessions.pop(token, None)
                return None
        if not self.accounts.is_current(session[0], session[1]):
            self.remove(token)
            return None
        return session[0]

    def remove(self, token: str) -> None:
        with self._lock:
            self._sessions.pop(token, None)
