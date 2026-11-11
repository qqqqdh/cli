from fastapi.testclient import TestClient

from dugoutlab.api import create_app
from dugoutlab.cli import main
from dugoutlab.db import connect
from dugoutlab.metrics import pitch_name
from dugoutlab.report import build_team_report, render_html
from dugoutlab.sample_data import planted_weaknesses


def test_team_report_structure(demo_db):
    con = connect(demo_db)
    ctx = build_team_report(con, "RED")
    assert ctx["team_name"] == "부산 레드포트"
    assert ctx["pitchers"] and ctx["batters"]
    assert all(p["profile"]["pitches"] >= 80 for p in ctx["pitchers"])
    assert ctx["pitchers"][0]["role"] == "선발"
    html = render_html(ctx)
    assert "부산 레드포트 스카우팅 리포트" in html
    assert html.count('class="card"') == len(ctx["pitchers"]) + len(ctx["batters"])
    assert "<svg" in html


def test_report_finds_planted_weaknesses(demo_db):
    """샘플 데이터에 심은 '특정 구종 헛스윙' 약점을 자동 코멘트가 찾아내는지 확인 (회귀 방지)."""
    con = connect(demo_db)
    source_of = {pid: sid for sid, pid in con.execute("SELECT source_id, player_id FROM player_id_map").fetchall()}
    planted = planted_weaknesses()
    found = flagged = total = 0
    for team in ("BLU", "RED", "GRN", "GLD"):
        for b in build_team_report(con, team)["batters"]:
            weak = next(iter(planted[source_of[b["id"]]]["weakness"]))
            pitch_notes = [n for n in b["notes"] if "에 헛스윙" in n]
            found += any(n.startswith(pitch_name(weak) + "에") for n in pitch_notes)
            flagged += len(pitch_notes)
            total += 1
    assert found / total >= 0.35
    assert found / flagged >= 0.7


def test_api_endpoints(demo_db):
    client = TestClient(create_app(demo_db))
    assert "투구 탐색기" in client.get("/").text
    teams = client.get("/api/teams").json()
    assert teams["teams"] == ["BLU", "GLD", "GRN", "RED"]

    players = client.get("/api/players", params={"team": "RED"}).json()
    pitcher = max(players, key=lambda p: p["pitches_thrown"])
    prof = client.get(f"/api/players/{pitcher['player_id']}", params={"role": "pitcher"}).json()
    assert prof["profile"]["pitches"] == pitcher["pitches_thrown"]

    res = client.get("/api/pitches", params={"pitcher_id": pitcher["player_id"], "pitch_type": ["FF", "SI"],
                                             "count": "2스트라이크"}).json()
    assert res["total"] > 0
    assert {p["pitch_type"] for p in res["points"]} <= {"FF", "SI"}
    assert all(p["strikes"] == 2 for p in res["points"])

    assert client.get("/api/pitches", params={"batter_team": "NONE"}).json()["total"] == 0
    assert client.get("/reports/team/RED").status_code == 200
    assert client.get("/reports/team/NONE").status_code == 404
    assert client.get("/api/players/NOPE").status_code == 404


def test_cli_demo_and_report(tmp_path, capsys):
    db = tmp_path / "cli.duckdb"
    assert main(["demo", "--db", str(db), "--games", "30"]) == 0
    out = tmp_path / "r.html"
    assert main(["report", "BLU", "--db", str(db), "--out", str(out), "--min-pitches", "30", "--min-pa", "5"]) == 0
    assert "서울 블루윙즈" in out.read_text(encoding="utf-8")
    assert main(["report", "XYZ", "--db", str(db)]) == 1
