import pytest

from dugoutlab.db import connect, set_team_name
from dugoutlab.ingest import ingest_dataframe
from dugoutlab.sample_data import TEAMS, generate


@pytest.fixture(scope="session")
def sample_df():
    return generate(n_games=120, seed=7)


@pytest.fixture(scope="session")
def demo_db(tmp_path_factory, sample_df):
    path = tmp_path_factory.mktemp("db") / "demo.duckdb"
    con = connect(path)
    ingest_dataframe(con, sample_df, source="sim")
    for code, name in TEAMS.items():
        set_team_name(con, code, name)
    con.close()
    return path


@pytest.fixture
def mem():
    con = connect(":memory:")
    yield con
    con.close()
