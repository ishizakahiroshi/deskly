"""設定済み台帳の組み立てと、台帳をまたぐ読み取り・ID 解決。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from deskly.config import Config, ConfigError, LedgerDefinition, load_ledger_config
from deskly.model import Contact, validate_contact_id
from deskly.remote_store import RemoteStore
from deskly.store import (
    LedgerStore,
    NotFoundError,
    SqliteStore,
    get_contact_readonly,
    list_contacts_readonly,
)


class AmbiguousContactError(ValueError):
    """同じ ID が複数の台帳にあり、書き込み先を決められない。"""


@dataclass(frozen=True)
class LedgerContact:
    """Contact と所属台帳の表示情報。DB の連絡欄には保存しない。"""

    ledger: LedgerDefinition
    contact: Contact

    def to_dict(self) -> dict[str, Any]:
        result = self.contact.to_dict()
        result["ledger"] = self.ledger.name
        result["ledger_label"] = self.ledger.label
        return result


class LedgerCollection:
    """設定された local / server 台帳群。"""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.definitions = config.ledgers
        if not self.definitions:
            raise ConfigError("台帳が 1 冊も設定されていません")

    @property
    def default(self) -> LedgerDefinition:
        if self.config.default_ledger is None:
            raise ConfigError("default_ledger が設定されていません")
        return self.config.ledger(self.config.default_ledger)

    def definition(self, name: str) -> LedgerDefinition:
        return self.config.ledger(name)

    @staticmethod
    def _local_path(definition: LedgerDefinition):
        if definition.storage != "local" or definition.path is None:
            raise ConfigError("local 台帳のパスがありません")
        return definition.path

    @staticmethod
    def _server_store(definition: LedgerDefinition) -> RemoteStore:
        if definition.storage != "server" or definition.url is None or definition.token_env is None:
            raise ConfigError("server 台帳の設定が正しくありません")
        token = os.environ.get(definition.token_env, "")
        if not token:
            raise ConfigError("server 台帳の認証トークンが未設定です")
        return RemoteStore(definition.url, token)

    def open_store(self, name: str) -> LedgerStore:
        """指定台帳を開く。server の token 値はエラーや表示へ含めない。"""
        definition = self.definition(name)
        if definition.storage == "local":
            return SqliteStore(self._local_path(definition))
        return self._server_store(definition)

    def list_contacts(self) -> list[LedgerContact]:
        """すべての台帳を読み、所属情報を付ける。local は読み取り専用で開く。"""
        contacts: list[LedgerContact] = []
        for definition in self.definitions:
            if definition.storage == "local":
                found = list_contacts_readonly(self._local_path(definition))
            else:
                with self.open_store(definition.name) as store:
                    found = store.list_contacts()
            contacts.extend(LedgerContact(definition, contact) for contact in found)
        return contacts

    def find_contact(self, contact_id: str) -> LedgerContact:
        """ID の所属台帳を探す。同一 ID が複数にあれば誤更新を防ぐため拒否する。"""
        valid_id = validate_contact_id(contact_id)
        matches: list[LedgerContact] = []
        has_ledger_file = False
        for definition in self.definitions:
            if definition.storage == "local":
                path = self._local_path(definition)
                if not path.is_file():
                    continue
                has_ledger_file = True
                try:
                    contact = get_contact_readonly(path, valid_id)
                except NotFoundError:
                    continue
            else:
                has_ledger_file = True
                try:
                    with self.open_store(definition.name) as store:
                        contact = store.get(valid_id)
                except NotFoundError:
                    continue
            matches.append(LedgerContact(definition, contact))
        if not matches:
            if not has_ledger_file:
                raise FileNotFoundError("台帳がありません")
            raise NotFoundError(f"連絡が見つかりません: {valid_id}")
        if len(matches) > 1:
            names = "・".join(item.ledger.label for item in matches)
            raise AmbiguousContactError(f"同じ ID が複数の台帳にあります: {names}")
        return matches[0]


def load_ledgers(config: Config | None = None) -> LedgerCollection:
    """台帳の組を作る。設定が無い場合は既定の company 1 冊を使う。"""
    return LedgerCollection(config or load_ledger_config())


__all__ = [
    "AmbiguousContactError",
    "LedgerCollection",
    "LedgerContact",
    "load_ledgers",
]
