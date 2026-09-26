"""連絡の型と、状態の 6 つの言葉。

deskly が持つのは連絡の台帳だけで、状態の言葉は下の 6 つだけ。新しい言葉を作らない。
"""

from __future__ import annotations

import re
import secrets
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from datetime import date
from typing import Any

STATE_DRAFT = "下書き"
STATE_SENT = "送信済み"
STATE_WAITING = "回答待ち"
STATE_IN_PROGRESS = "対応中"
STATE_DONE = "完了"
STATE_NOT_SENT = "送らない"

# 状態の言葉。順序に意味は無い（今の reply-status.ps1 と同じ 6 つ）。
STATES: tuple[str, ...] = (
    STATE_DRAFT,
    STATE_SENT,
    STATE_WAITING,
    STATE_IN_PROGRESS,
    STATE_DONE,
    STATE_NOT_SENT,
)


class InvalidStateError(ValueError):
    """6 つの言葉以外の状態を渡された。"""


def validate_state(state: object) -> str:
    """状態が 6 つの言葉のどれかなら、そのまま返す。違えば ``InvalidStateError``。"""
    if not isinstance(state, str) or state not in STATES:
        raise InvalidStateError(
            f"状態は {'・'.join(STATES)} のどれかだけです（渡された値: {state!r}）"
        )
    return state


_CONTACT_ID_RE = re.compile(r"c-\d{8}-[0-9a-f]{8}")


def new_contact_id(today: date | None = None) -> str:
    """連絡の ID ``c-YYYYMMDD-<8 桁の 16 進>`` を作る。台帳を移しても変わらない。"""
    day = today or date.today()
    return f"c-{day:%Y%m%d}-{secrets.token_hex(4)}"


def validate_contact_id(contact_id: object) -> str:
    """連絡の ID の形（``c-YYYYMMDD-<8 桁の 16 進>``）を検査して、そのまま返す。"""
    if not isinstance(contact_id, str) or not _CONTACT_ID_RE.fullmatch(contact_id):
        raise ValueError(
            f"連絡の ID は c-YYYYMMDD-<8 桁の 16 進> の形だけです（渡された値: {contact_id!r}）"
        )
    return contact_id


@dataclass(frozen=True)
class Contact:
    """連絡 1 件。管理の欄と本文を持つ。文字の欄が無いときは空文字。"""

    id: str
    state: str = STATE_DRAFT
    # 状態が取り込み時の推定かどうか（状態の行が無い返信テキストを推定で埋めたときに True）
    state_inferred: bool = False
    project: str = ""  # 案件。無ければ空（返信テキストの「なし」は取り込み側で空にする）
    recipient: str = ""  # 宛先
    channel: str = ""  # 経路
    sent_at: str = ""  # 送信日時
    due: str = ""  # 依頼期限
    promise: str = ""  # 約束
    agreement: str = ""  # 合意
    sensitive: str = ""  # 機微
    basis: str = ""  # 根拠
    note: str = ""  # 補足
    references: str = ""  # 参照
    shared_url: str = ""  # 共有 URL
    body: str = ""  # 本文
    source_path: str = ""  # 取り込み元のパス
    source_hash: str = ""  # 取り込み元の内容のハッシュ
    extra: Mapping[str, str] = field(default_factory=dict)  # ヘッダの知らない欄
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        """JSON にできる辞書。書き出しと ``--json`` の出力の元になる。"""
        data = {f.name: getattr(self, f.name) for f in fields(self)}
        data["extra"] = dict(self.extra)
        return data


# ID・作成日時・更新日時は台帳が決める。呼び出し側が更新できる欄はこれだけ。
MUTABLE_FIELDS: tuple[str, ...] = tuple(
    f.name for f in fields(Contact) if f.name not in ("id", "created_at", "updated_at")
)
_BOOL_FIELDS = frozenset({"state_inferred"})
_MAPPING_FIELDS = frozenset({"extra"})


def normalize_field(name: str, value: object) -> Any:
    """欄の値を検査して、保存する形（``extra`` は ``dict[str, str]``）にそろえる。"""
    if name not in MUTABLE_FIELDS:
        raise ValueError(f"更新できない欄です: {name}")
    if name == "state":
        return validate_state(value)
    if name in _BOOL_FIELDS:
        if not isinstance(value, bool):
            raise TypeError(f"{name} は bool だけです（渡された型: {type(value).__name__}）")
        return value
    if name in _MAPPING_FIELDS:
        if not isinstance(value, Mapping) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in value.items()
        ):
            raise TypeError(f"{name} は 文字 → 文字 の辞書だけです")
        return dict(value)
    if not isinstance(value, str):
        raise TypeError(f"{name} は文字だけです（渡された型: {type(value).__name__}）")
    return value
