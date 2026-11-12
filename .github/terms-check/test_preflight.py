# tests/test_preflight.py
from pathlib import Path
from preflight import scan, exit_code

def test_phrase_from_private_file_is_caught(tmp_path: Path):
    priv = tmp_path / "CLAUDE.local.md"
    priv.write_text("# notes\nThe pilot client is Jane Example of Acme Corporation.\nshort\n")
    r = scan("Summary: we deployed. The pilot client is Jane Example of Acme Corporation. Done.", [priv], [])
    assert not r.clean and r.matches[0].kind == "phrase" and exit_code(r) == 1

def test_short_lines_are_not_phrases(tmp_path: Path):
    priv = tmp_path / "p.md"; priv.write_text("deploy now\n")
    r = scan("we deploy now", [priv], ["Acme"])
    assert r.clean and exit_code(r) == 0

def test_terms_match_on_word_boundaries_case_insensitive():
    r = scan("Talked to ACME today", [], ["acme"])
    assert not r.clean and r.matches[0].kind == "term"
    assert scan("Talked to acmeology today", [], ["acme"]).clean

def test_vacuous_when_nothing_to_compare(tmp_path: Path):
    r = scan("anything", [tmp_path / "missing.md"], [])
    assert r.vacuous and not r.clean and exit_code(r) == 3

# R22: jared's semantics. A term is bounded by a non-alphanumeric character or the text edge on each side.
def test_terms_match_inside_hyphen_and_underscore_compounds_and_punctuation():
    for text in ("deployed to acme-portal", "deployed to acme_portal", "the (acme) account", "Acme's invoice", "portal-acme", "acme"):
        assert not scan(text, [], ["acme"]).clean, text
    for text in ("acmeology", "reacme", "acme2", "2acme"):
        assert scan(text, [], ["acme"]).clean, text

def test_table_row_and_backticked_lines_are_phrases(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_text("| The pilot client is Jane Example of Acme |\n`Invoices go to the Example Holdings office`\n")
    r = scan("The pilot client is Jane Example of Acme", [priv], [])
    assert not r.clean and r.matches[0].kind == "phrase" and r.matches[0].needle == "The pilot client is Jane Example of Acme"
    r = scan("Invoices go to the Example Holdings office", [priv], [])
    assert not r.clean and r.matches[0].needle == "Invoices go to the Example Holdings office"

def test_table_separator_row_is_not_a_phrase(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_text("> - * # `| ---- | ---- | ---- |`\n")
    assert scan("anything at all", [priv], []).vacuous


# R28/I2: a source that cannot be read in full is a stop (exit 3), whatever else was compared.
def test_a_missing_source_is_vacuous_even_when_terms_are_set(tmp_path: Path):
    missing = tmp_path / "CLAUDE.local.md"
    r = scan("The pilot client is Jane Example of Acme Corporation", [missing], ["Zebra"])
    assert r.vacuous and not r.clean and exit_code(r) == 3 and r.unreadable == [str(missing)]

def test_a_utf16_source_is_vacuous(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_text("The pilot client is Jane Example of Acme Corporation.\n", encoding="utf-16")
    r = scan("The pilot client is Jane Example of Acme Corporation.", [priv], ["Zebra"])
    assert r.vacuous and exit_code(r) == 3 and r.unreadable == [str(priv)]

def test_a_utf16_source_without_a_bom_is_vacuous(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_bytes("The pilot client is Jane Example of Acme Corporation.\n".encode("utf-16-le"))   # valid UTF-8 full of NULs
    assert exit_code(scan("anything", [priv], ["Zebra"])) == 3

def test_a_latin1_source_is_vacuous(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_bytes("The pilot client is Zo\u00eb Example of Acme Corporation.\n".encode("latin-1"))
    assert exit_code(scan("anything", [priv], ["Zebra"])) == 3

def test_a_directory_source_is_vacuous(tmp_path: Path):
    d = tmp_path / "notes"; d.mkdir()
    r = scan("anything", [d], ["Zebra"])
    assert r.vacuous and exit_code(r) == 3 and r.unreadable == [str(d)]

def test_one_unreadable_source_makes_a_scan_with_a_good_source_vacuous(tmp_path: Path):
    good = tmp_path / "good.md"; good.write_text("The pilot client is Jane Example of Acme Corporation.\n")
    r = scan("nothing to see", [good, tmp_path / "gone.md"], [])
    assert exit_code(r) == 3 and r.unreadable == [str(tmp_path / "gone.md")]

def test_a_utf8_bom_is_fine_and_the_first_line_matches(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_bytes(b"\xef\xbb\xbfThe pilot client is Jane Example of Acme Corporation.\nshort\n")
    r = scan("we met. The pilot client is Jane Example of Acme Corporation. ok", [priv], [])
    assert not r.vacuous and r.unreadable == [] and exit_code(r) == 1 and r.matches[0].kind == "phrase"

def test_all_sources_readable_leaves_unreadable_empty(tmp_path: Path):
    priv = tmp_path / "p.md"; priv.write_text("The pilot client is Jane Example of Acme Corporation.\n")
    assert scan("clean text", [priv], []).unreadable == []

# R28/I3: a printed report never shows the private phrase or term; `label` is the safe way to name a match.
def test_repr_and_label_never_show_the_needle(tmp_path: Path):
    priv = tmp_path / "CLAUDE.local.md"
    priv.write_text("# notes\nThe pilot client is Jane Example of Acme Corporation.\n")
    r = scan("The pilot client is Jane Example of Acme Corporation. Also Zebra.", [priv], ["Zebra", "Quokka"])
    assert [m.kind for m in r.matches] == ["phrase", "term"]
    assert r.matches[0].needle == "The pilot client is Jane Example of Acme Corporation."   # the data is still there for local use
    assert r.matches[0].label == "phrase from CLAUDE.local.md line 2"
    assert r.matches[1].label == "term #1"
    shown = repr(r) + repr(r.matches[0]) + "".join(m.label for m in r.matches) + str(r.matches[1])
    for secret in ("Jane Example", "Acme Corporation", "Zebra", "pilot client"):
        assert secret not in shown

def test_term_label_counts_the_position_in_the_given_list():
    r = scan("a Quokka here", [], ["Zebra", "", "Quokka"])
    assert r.matches[0].label == "term #3"

# R28/M1: multi-word terms are whitespace-normalised the way phrases are.
def test_multiword_terms_match_across_whitespace_variants():
    for text in ("met Jane  Example today", "met Jane\nExample today", "met Jane\u00a0Example today", "met JANE\tEXAMPLE."):
        assert not scan(text, [], ["Jane Example"]).clean, text
    assert scan("met Jane Exampleton", [], ["Jane Example"]).clean
    assert not scan("met Jane Example", [], ["  Jane   Example "]).clean


# ---- #33: `line` is the 1-based line of the scanned text where the hit begins, never the matched text itself ------------

def test_line_a_term_on_line_3_reports_line_3():
    r = scan("one\ntwo\nAcme is here\nfour", [], ["Acme"])
    assert r.matches[0].line == 3

def test_line_a_two_word_term_split_across_lines_4_and_5_reports_line_4():
    r = scan("one\ntwo\nthree\nJane\nExample\nsix", [], ["Jane Example"])
    assert r.matches[0].line == 4

def test_line_a_term_appearing_twice_reports_the_first_line_it_appears_on():
    r = scan("x\nAcme\ny\nAcme\n", [], ["Acme"])
    assert r.matches[0].line == 2

def test_line_a_source_phrase_reports_its_line_in_the_scanned_text(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_text("The pilot client is Jane Example of Acme Corporation.\n")
    text = "intro line\nsecond line\nThe pilot client is Jane Example of Acme Corporation.\nfourth line"
    r = scan(text, [priv], [])
    assert r.matches[0].line == 3

def test_line_a_phrase_running_straight_into_the_next_word_still_reports_its_own_line(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_text("The pilot client is Jane Example of Acme Corporation.\n")
    text = ("intro line\nsecond line\nThe pilot client is Jane Example of Acme Corporation."
            "Next sentence runs on\nfourth line")
    r = scan(text, [priv], [])
    assert r.matches[0].line == 3

def test_line_never_reveals_the_matched_text_in_the_label_or_a_reason(tmp_path: Path):
    priv = tmp_path / "p.md"
    priv.write_text("The pilot client is Jane Example of Acme Corporation.\n")
    text = "ok so far\nThe pilot client is Jane Example of Acme Corporation. Also Zebra.\n"
    r = scan(text, [priv], ["Zebra"])
    assert [m.kind for m in r.matches] == ["phrase", "term"]
    for m in r.matches:
        shown = f"{m.kind}: {m.label} at line {m.line}"
        for secret in ("Jane", "Example", "Acme", "pilot client", "Zebra"):
            assert secret not in shown
