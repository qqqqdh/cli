# DugoutLab — 야구 전력분석 지원 도구 (1단계 MVP)

전력분석파트가 경기 전 상대 분석 리포트를 만드는 시간을 줄이기 위한 도구입니다.
설계 제안서의 **1단계 MVP** 범위를 구현했습니다.

| 기능 | 내용 |
| --- | --- |
| 데이터 수집·정제 | 투구 CSV 적재, 장비별 컬럼·단위·코드 매핑, 검증(거부 행·범위 밖 값 보고), 소스별 선수 ID 통합, 재적재 시 중복 없음 |
| 투구 탐색기 | 웹 화면에서 팀·선수·구종·볼카운트·결과·상대 손·기간으로 필터, 로케이션 산점도, 구종별 지표, 투구를 누르면 영상 타임코드 재생 |
| 선수 프로필 | 투수: 구종 구성·구속·회전·무브먼트·헛스윙·결정구·볼카운트별 패턴 / 타자: 슬래시 라인·wOBA·체이스·구종별 약점·코스별 히트맵·타구 성향 |
| 스카우팅 리포트 | 상대팀 투수진·타선 리포트를 HTML로 자동 생성(인쇄 가능), 선택적으로 PDF. 표본이 충분할 때만 자동 코멘트 |

## 빠른 시작

```bash
cd dugoutlab
pip install -e ".[dev]"

# 1) 가상 리그 샘플 데이터로 DB 만들기 (실제 데이터 연동 전 시연용)
dugoutlab demo --db demo.duckdb

# 2) 상대팀 스카우팅 리포트 (HTML)
dugoutlab report RED --db demo.duckdb --out report_RED.html

# 3) 투구 탐색기 웹 화면 → http://127.0.0.1:8000/
dugoutlab serve --db demo.duckdb
```

샘플 데이터의 팀·선수는 모두 가상이며, 타자마다 약점(특정 구종 헛스윙, 약한 코스)을 심어 두었습니다.
리포트가 이 약점을 찾아내는지 테스트로 확인합니다.

## 실제 데이터 넣기

```bash
dugoutlab ingest 경기_0401.csv 경기_0402.csv --db team.duckdb --source league
dugoutlab ingest trackman_0401.csv --db team.duckdb --mapping mappings/trackman_template.json
dugoutlab team LG "LG 트윈스" --db team.duckdb   # 리포트에 표시할 팀 이름
```

표준 컬럼(단위: 속도 km/h, 거리 cm, 위치는 포수 시점)

| 컬럼 | 필수 | 설명 |
| --- | --- | --- |
| `game_id`, `pa_seq`, `pitch_num` | ● | 경기 ID, 경기 내 타석 번호, 타석 내 투구 번호 (`pa_seq` 가 없으면 `pitch_num`=1 기준으로 자동 생성) |
| `pitcher_id`, `batter_id` | ● | 소스의 선수 ID (`--source` 별로 내부 ID에 매핑) |
| `pitch_type` | ● | FF, SI, FC, SL, ST, CU, CH, FS, KN |
| `description` | ● | ball, called_strike, swinging_strike, foul, foul_tip, in_play, hit_by_pitch … |
| `pa_result` | | 타석 마지막 투구에만: single, double, triple, home_run, field_out, strikeout, walk … |
| `pitcher_name`, `pitcher_team`, `p_throws`, `batter_name`, `batter_team`, `stand` | | 이름·팀이 있으면 다른 소스의 같은 선수와 자동으로 묶임 |
| `game_date`, `inning`, `top_bottom`, `balls`, `strikes`, `outs`, `on_1b/2b/3b` | | 경기 상황 |
| `release_speed`, `spin_rate`, `pfx_x`, `pfx_z`, `plate_x`, `plate_z`, `release_x`, `release_z`, `extension` | | 트래킹 값 |
| `launch_speed`, `launch_angle`, `spray_angle` | | 타구 (spray 음수 = 3루 방향) |
| `video_url`, `video_ts` | | 경기 영상 경로와 해당 투구 시점(초) |

장비마다 컬럼 이름·단위·코드가 다르므로 매핑 JSON(`columns`, `units`, `values`)으로 맞춥니다.
`mappings/trackman_template.json` 은 시작용 템플릿이며, 구단의 실제 내보내기 파일과 컬럼명·좌우 부호를 대조한 뒤 쓰세요.

## PDF 저장

```bash
pip install -e ".[pdf]" && playwright install chromium
dugoutlab report RED --db team.duckdb --pdf report_RED.pdf
```

한글이 깨지면 서버에 한글 폰트(예: Noto Sans KR)를 설치하세요. HTML 리포트는 브라우저에서 바로 인쇄해도 됩니다.

## 구조

```
dugoutlab/
  db.py           DuckDB 스키마 (teams, players, player_id_map, games, pitches, ingest_log)
  ingest.py       CSV 적재: 매핑 → 단위 변환 → 검증 → 선수 ID 통합 → 저장
  metrics.py      지표 계산 (헛스윙%, 체이스%, wOBA, 결정구%, 코스 격자, 자동 코멘트)
  queries.py      필터 조회
  report.py       스카우팅 리포트 (Jinja2 HTML / Playwright PDF)
  svg.py          인라인 SVG 차트 (히트맵, 무브먼트, 구종 비율)
  api.py          FastAPI: /api/teams, /api/players, /api/players/{id}, /api/pitches, /reports/team/{team}
  templates/      리포트·탐색기 화면
  sample_data.py  가상 리그 시뮬레이터
```

## 알려진 한계 (다음 단계에서 다룸)

- 스트라이크존 상·하단은 고정값(45~105cm)입니다. 타자 키별 존 보정은 아직 없습니다.
- wOBA 가중치는 일반적인 리그 값의 근사치입니다. 리그·시즌별 값은 `metrics.WOBA_WEIGHTS` 에서 바꿉니다.
- 구장 보정, 기대치 지표(xBA·xwOBA), 매치업 뷰, 더그아웃 오프라인 모드, 로그인·권한은 2단계 범위입니다.

## 테스트

```bash
pytest
```
