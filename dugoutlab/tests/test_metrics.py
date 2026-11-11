import math

import pandas as pd
import pytest

from dugoutlab import metrics as m


def pitches(rows):
    base = dict(game_id="g1", balls=0, strikes=0, stand="R", p_throws="R", pitch_type="FF",
                plate_x=0.0, plate_z=75.0, pa_result=None, launch_speed=None, launch_angle=None,
                spray_angle=None, release_speed=145.0, spin_rate=2300.0, pfx_x=-15.0, pfx_z=40.0)
    return m.add_flags(pd.DataFrame([{**base, **r} for r in rows]))


def test_wilson_matches_known_value():
    lo, hi = m.wilson(10, 20)
    assert lo == pytest.approx(0.2993, abs=1e-3)
    assert hi == pytest.approx(0.7007, abs=1e-3)
    assert all(math.isnan(v) for v in m.wilson(0, 0))


@pytest.mark.parametrize("balls,strikes,expected", [
    (0, 0, "초구"), (0, 1, "투수 유리"), (2, 1, "타자 유리"), (1, 1, "동일"), (3, 2, "2스트라이크"),
])
def test_count_bucket(balls, strikes, expected):
    assert m.count_bucket(balls, strikes) == expected


def test_discipline_rates():
    d = pitches([
        dict(description="swinging_strike"),                           # 존 안 헛스윙
        dict(description="foul"),                                      # 존 안 파울
        dict(description="ball", plate_x=40.0),                        # 존 밖 볼
        dict(description="swinging_strike", plate_x=40.0, strikes=2,   # 존 밖 헛스윙 삼진
             pa_result="strikeout"),
    ])
    disc = m.discipline(d)
    assert disc["zone"]["value"] == 0.5
    assert disc["swing"]["value"] == 0.75
    assert disc["chase"]["value"] == 0.5
    assert disc["whiff"]["value"] == pytest.approx(2 / 3)


def test_slash_line_and_woba():
    d = pitches([
        dict(description="in_play", pa_result="single", launch_speed=150.0, launch_angle=15.0),
        dict(description="in_play", pa_result="home_run", launch_speed=170.0, launch_angle=28.0),
        dict(description="ball", pa_result="walk", balls=3),
        dict(description="swinging_strike", pa_result="strikeout", strikes=2),
    ])
    line = m.slash_line(d)
    assert line["pa"] == 4 and line["ab"] == 3 and line["h"] == 2
    assert line["avg"] == pytest.approx(2 / 3)
    assert line["obp"] == pytest.approx(3 / 4)
    assert line["slg"] == pytest.approx(5 / 3)
    assert line["woba"] == pytest.approx((0.89 + 2.10 + 0.69) / 4)
    assert line["k"]["value"] == 0.25


def test_zone_grid_places_points():
    d = pitches([
        dict(description="ball", plate_x=0.0, plate_z=75.0),     # 한가운데 → (2,2)
        dict(description="ball", plate_x=-20.0, plate_z=100.0),  # 존 안 왼쪽 위 → (1,1)
        dict(description="ball", plate_x=90.0, plate_z=10.0),    # 멀리 빠진 공 → 바깥 칸 (4,4)
    ])
    cells = m.zone_grid(d, "freq")["cells"]
    assert cells[2][2]["n"] == 1
    assert cells[1][1]["n"] == 1
    assert cells[4][4]["n"] == 1


def test_zone_label_depends_on_batter_hand():
    assert m.zone_label(1, 1, "R") == "높은 몸쪽"
    assert m.zone_label(1, 1, "L") == "높은 바깥쪽"


def test_spray_direction_by_hand():
    d = pitches([
        dict(description="in_play", pa_result="field_out", launch_speed=140.0, launch_angle=5.0, spray_angle=-30.0, stand="R"),
        dict(description="in_play", pa_result="field_out", launch_speed=140.0, launch_angle=5.0, spray_angle=30.0, stand="L"),
        dict(description="in_play", pa_result="single", launch_speed=140.0, launch_angle=5.0, spray_angle=30.0, stand="R"),
    ])
    bb = m.batted_ball(d)
    assert bb["pull"]["value"] == pytest.approx(2 / 3)
    assert bb["oppo"]["value"] == pytest.approx(1 / 3)
