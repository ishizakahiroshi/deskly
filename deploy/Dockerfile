# deskly のイメージ。
#
# いまは仮の中身: release の RELEASE（版の情報の JSON）を /srv/healthz として返すだけ。
# 置き場と配り方を先に確かめるためのもので、段階 1 で本物の deskly
#（wheel を入れて `deskly serve-api` を動かす形）に差し替える。
FROM python:3.12-slim

WORKDIR /srv
COPY RELEASE /srv/healthz

EXPOSE 8765
# コンテナの中では全アドレスで待ち受ける。外へ出すかどうかは compose の ports（127.0.0.1 だけ）で決める
CMD ["python", "-m", "http.server", "8765", "--bind", "0.0.0.0", "--directory", "/srv"]
