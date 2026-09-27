#!/bin/sh
# deskly の release を /opt/deskly へ反映する。サーバーの上で root として動かす。
#
# 使い方:
#   install-release.sh <release を固めた tar.gz>   新しい版を反映する
#   install-release.sh rollback                    直前の版へ戻す（もう一度流すと戻す前の版へ戻る）
#   install-release.sh status                      今の版と healthz を出す
#
# 置き場:
#   /opt/deskly/app/compose.yaml      compose（配るたびに置き直される）
#   /opt/deskly/app/.env              秘密の値（root:root 600。無くても起動する）
#   /opt/deskly/release/current/      今の版（Dockerfile・RELEASE・（あれば）dist/*.whl）
#   /opt/deskly/backup/release.prev/  直前の版
#   /opt/deskly/backup/release.failed/ healthz を返さずに戻した版（調べるために残す）
#
# 反映の流れ: 展開 → 今の版を退避して置き換え → build と起動 → healthz が新しい revision を
# 返すまで待つ → 返さなければ前の版へ戻す。起動しただけでは成功にしない。
set -eu

BASE=/opt/deskly
APP="$BASE/app"
CUR="$BASE/release/current"
PREV="$BASE/backup/release.prev"
FAILED="$BASE/backup/release.failed"
SWAP="$BASE/backup/release.swap"
INCOMING="$BASE/release/incoming"
PORT="${DESKLY_PORT:-8765}"

log() { echo "[install-release] $*"; }

shared_web_enabled() {
	[ -f "$APP/compose.company-web.yaml" ] && [ -f "$APP/web.env.local" ]
}

compose() {
	if shared_web_enabled; then
		docker compose -p deskly -f "$APP/compose.yaml" -f "$APP/compose.company-web.yaml" "$@"
	else
		docker compose -p deskly -f "$APP/compose.yaml" "$@"
	fi
}

release_revision() {
	sed -n 's/.*"revision"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/RELEASE"
}

fetch_healthz() {
	url="http://127.0.0.1:$PORT/healthz"
	if command -v curl >/dev/null 2>&1; then
		curl -fsS --max-time 3 "$url" 2>/dev/null
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- --timeout=3 "$url" 2>/dev/null
	else
		python3 -c "import urllib.request,sys; sys.stdout.write(urllib.request.urlopen('$url', timeout=3).read().decode())" 2>/dev/null
	fi
}

healthz_revision() {
	fetch_healthz | sed -n 's/.*"revision"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# healthz が $1 の revision を返すまで、最大 60 秒待つ
wait_for() {
	want="$1"
	i=0
	while [ "$i" -lt 30 ]; do
		got="$(healthz_revision || true)"
		if [ "$got" = "$want" ]; then
			return 0
		fi
		i=$((i + 1))
		sleep 2
	done
	return 1
}

wait_for_web() {
	if ! shared_web_enabled; then
		return 0
	fi
	i=0
	while [ "$i" -lt 30 ]; do
		if compose exec -T web python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8766/healthz', timeout=2).close()" >/dev/null 2>&1; then
			return 0
		fi
		i=$((i + 1))
		sleep 2
	done
	return 1
}

up() {
	compose up -d --build app
	if shared_web_enabled; then
		compose up -d --no-deps --force-recreate web
	fi
}

# $1 のディレクトリを今の版にし、それまでの今の版を直前の版として残す
swap_in() {
	rm -rf "$SWAP"
	if [ -d "$CUR" ]; then
		mv "$CUR" "$SWAP"
	fi
	mv "$1" "$CUR"
	if [ -d "$SWAP" ]; then
		rm -rf "$PREV"
		mv "$SWAP" "$PREV"
	fi
}

install -d -m 755 "$BASE" "$APP" "$BASE/release" "$BASE/backup"

case "${1:-}" in
status)
	if [ -f "$CUR/RELEASE" ]; then
		log "今の版: $(release_revision "$CUR")"
	else
		log "今の版: なし"
	fi
	if [ -f "$PREV/RELEASE" ]; then
		log "直前の版: $(release_revision "$PREV")"
	fi
	log "healthz: $(fetch_healthz || echo '応答なし')"
	if shared_web_enabled; then
		if wait_for_web; then log "shared Web healthz: ok"; else log "shared Web healthz: 応答なし"; fi
	fi
	exit 0
	;;
rollback)
	if [ ! -f "$PREV/RELEASE" ]; then
		log "戻す版がありません: $PREV"
		exit 1
	fi
	want="$(release_revision "$PREV")"
	log "直前の版 $want へ戻します"
	rm -rf "$INCOMING"
	mv "$PREV" "$INCOMING"
	swap_in "$INCOMING"
	up
	if wait_for "$want" && wait_for_web; then
		log "戻しました: healthz が $want を返しています"
		exit 0
	fi
	log "戻した版 $want が healthz を返しません"
	compose logs --tail 30 app || true
	exit 1
	;;
"")
	echo "使い方: install-release.sh <release.tar.gz> | rollback | status" >&2
	exit 2
	;;
esac

ARCHIVE="$1"
if [ ! -f "$ARCHIVE" ]; then
	log "release のファイルがありません: $ARCHIVE"
	exit 1
fi

rm -rf "$INCOMING"
mkdir -p "$INCOMING"
tar -xzf "$ARCHIVE" -C "$INCOMING"
for need in Dockerfile RELEASE; do
	if [ ! -f "$INCOMING/$need" ]; then
		log "release に $need がありません。反映をやめます"
		rm -rf "$INCOMING"
		exit 1
	fi
done
want="$(release_revision "$INCOMING")"
if [ -z "$want" ]; then
	log "RELEASE に revision がありません。反映をやめます"
	rm -rf "$INCOMING"
	exit 1
fi

log "新しい版 $want を反映します"
swap_in "$INCOMING"
up

if wait_for "$want" && wait_for_web; then
	log "反映しました: healthz が $want を返しています"
	exit 0
fi

log "新しい版 $want が healthz を返しません。前の版へ戻します"
compose logs --tail 30 app || true
rm -rf "$FAILED"
mv "$CUR" "$FAILED"
if [ -d "$PREV" ]; then
	mv "$PREV" "$CUR"
	up
	back="$(release_revision "$CUR")"
	if wait_for "$back" && wait_for_web; then
		log "前の版 $back に戻しました（失敗した版は $FAILED に残しています）"
	else
		log "前の版 $back も healthz を返しません"
	fi
else
	log "戻す版がありません（初めての反映）。コンテナを止めます"
	compose down || true
fi
exit 1
