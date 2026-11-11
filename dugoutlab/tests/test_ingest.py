import json

import pandas as pd

from dugoutlab.ingest import ingest_csv, ingest_dataframe


def row(**kw):
    base = dict(game_id="G1", game_date="2026-04-01", pa_seq=1, pitch_num=1, pitcher_id="p1",
                pitcher_name="김투수", pitcher_team="AAA", p_throws="R", batter_id="b1",
                batter_name="이타자", batter_team="BBB", stand="L", balls=0, strikes=0,
                pitch_type="ff", release_speed=145.0, plate_x=0.0, plate_z=70.0, description="Ball")
    return {**base, **kw}


def test_loads_and_normalizes(mem):
    df = pd.DataFrame([row(), row(pitch_num=2, description="in_play", pa_result="single")])
    res = ingest_dataframe(mem, df, source="t")
    assert res.rows_loaded == 2 and res.rows_rejected == 0 and res.new_players == 2
    stored = mem.execute("SELECT pitch_type, description FROM pitches ORDER BY pitch_num").fetchall()
    assert stored == [("FF", "ball"), ("FF", "in_play")]
    assert mem.execute("SELECT bats FROM players WHERE name = '이타자'").fetchone()[0] == "L"


def test_rejects_bad_rows_and_blanks_out_of_range(mem):
    df = pd.DataFrame([
        row(),
        row(pitch_num=2, pitcher_id=None),
        row(pitch_num=3, description="moonball"),
        row(pitch_num=4, release_speed=999.0),
    ])
    res = ingest_dataframe(mem, df, source="t")
    assert res.rows_loaded == 2
    assert [r for r, _ in res.rejected] == [3, 4]
    assert any("release_speed" in w for w in res.warnings)
    assert mem.execute("SELECT release_speed FROM pitches WHERE pitch_num = 4").fetchone()[0] is None


def test_reingest_is_idempotent(mem):
    df = pd.DataFrame([row(), row(pitch_num=2)])
    ingest_dataframe(mem, df, source="t")
    ingest_dataframe(mem, df.assign(release_speed=150.0), source="t")
    assert mem.execute("SELECT count(*), max(release_speed) FROM pitches").fetchone() == (2, 150.0)
    assert mem.execute("SELECT count(*) FROM players").fetchone()[0] == 2


def test_same_player_across_sources_by_name_and_team(mem):
    ingest_dataframe(mem, pd.DataFrame([row()]), source="league")
    ingest_dataframe(mem, pd.DataFrame([row(game_id="G2", pitcher_id="TM-9", batter_id="TM-1")]), source="trackman")
    assert mem.execute("SELECT count(*) FROM players").fetchone()[0] == 2
    assert mem.execute("SELECT count(DISTINCT pitcher_id) FROM pitches").fetchone()[0] == 1


def test_mapping_file_with_units_and_values(mem, tmp_path):
    vendor = pd.DataFrame([{
        "GameID": "V1", "PitchofPA": 1, "PitcherId": "x", "BatterId": "y",
        "TaggedPitchType": "Slider", "PitchCall": "StrikeSwinging", "RelSpeed": 90.0, "PlateLocSide": 0.5,
    }, {
        "GameID": "V1", "PitchofPA": 1, "PitcherId": "x", "BatterId": "z",
        "TaggedPitchType": "Fastball", "PitchCall": "BallCalled", "RelSpeed": 95.0, "PlateLocSide": -1.0,
    }])
    csv = tmp_path / "v.csv"
    vendor.to_csv(csv, index=False)
    mapping = tmp_path / "m.json"
    mapping.write_text(json.dumps({
        "source": "vendor",
        "columns": {"GameID": "game_id", "PitchofPA": "pitch_num", "PitcherId": "pitcher_id", "BatterId": "batter_id",
                    "TaggedPitchType": "pitch_type", "PitchCall": "description", "RelSpeed": "release_speed",
                    "PlateLocSide": "plate_x"},
        "units": {"release_speed": "mph", "plate_x": "ft"},
        "values": {"pitch_type": {"Slider": "SL", "Fastball": "FF"},
                   "description": {"StrikeSwinging": "swinging_strike", "BallCalled": "ball"}},
    }), encoding="utf-8")
    res = ingest_csv(mem, csv, mapping_path=mapping)
    assert res.rows_loaded == 2
    assert any("pa_seq" in w for w in res.warnings)
    rows = mem.execute("SELECT pa_seq, pitch_type, description, round(release_speed, 1), round(plate_x, 2) "
                       "FROM pitches ORDER BY pa_seq").fetchall()
    assert rows == [(1, "SL", "swinging_strike", 144.8, 15.24), (2, "FF", "ball", 152.9, -30.48)]
