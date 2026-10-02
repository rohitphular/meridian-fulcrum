import io

import pytest

import core.credentials as credentials

# RFC 6238 appendix B, SHA1 key "12345678901234567890" (the last 6 of each 8-digit code).
_RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


@pytest.mark.parametrize("at,code", [(59, "287082"), (1111111109, "081804"), (1234567890, "005924"), (2000000000, "279037")])
def test_totp_code_matches_rfc_6238_vectors(at: int, code: str) -> None:
    assert credentials.totp_code(_RFC_SECRET, at) == code


def test_totp_code_ignores_case_spaces_and_padding_like_gas() -> None:
    assert credentials.totp_code("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==", 59) == "287082"


@pytest.fixture
def no_stored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(credentials.PIN_VARIABLE, raising=False)
    monkeypatch.delenv(credentials.SECRET_VARIABLE, raising=False)


def test_stored_credentials_need_both_variables(no_stored: None, monkeypatch: pytest.MonkeyPatch) -> None:
    assert credentials.stored_credentials() is None
    monkeypatch.setenv(credentials.PIN_VARIABLE, "9731")
    with pytest.raises(ValueError, match="^incomplete_stored_credentials$"):
        credentials.stored_credentials()
    monkeypatch.setenv(credentials.SECRET_VARIABLE, _RFC_SECRET)
    monkeypatch.setattr(credentials.time, "time", lambda: 59.0)
    assert credentials.stored_credentials() == ("9731", "287082")


def test_stored_credentials_win_over_prompts_and_stdin(no_stored: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(credentials.PIN_VARIABLE, "9731")
    monkeypatch.setenv(credentials.SECRET_VARIABLE, _RFC_SECRET)
    monkeypatch.setattr(credentials.time, "time", lambda: 59.0)
    monkeypatch.setattr(credentials.getpass, "getpass", lambda prompt: pytest.fail("no prompt expected"))
    monkeypatch.setattr(credentials.sys, "stdin", io.StringIO("0000\n111111\n"))
    assert credentials.read_credentials() == ("9731", "287082")
    assert credentials.read_credentials_from_stdin(with_code=True) == ("9731", "287082")
    assert credentials.read_credentials_from_stdin(with_code=False) == ("9731", None)


def test_without_stored_credentials_stdin_is_used(no_stored: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(credentials.sys, "stdin", io.StringIO("9731\n123456\n"))
    assert credentials.read_credentials_from_stdin(with_code=True) == ("9731", "123456")


@pytest.mark.parametrize("secret", ["123456", "9731", "", "1890", "234567234567234567", "JBSWY3DP"])
def test_a_code_or_pin_in_the_secret_variable_is_explained(secret: str, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(ValueError, match="^stored_secret_not_base32$"):
        credentials.totp_code(secret, 59)
    assert "must be the Base32 TOTP secret" in capsys.readouterr().err
