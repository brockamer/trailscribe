# workbench/preflight.py
"""Redaction pre-flight, after jared's (#102): refuse to post text that repeats a private phrase or a private term.
A phrase is a line from a private source with 20+ characters and 3+ words. A term matches on word boundaries.
A scan that had nothing to compare, or could not read every source it was given, is vacuous, and vacuous is never clean.
A Match keeps the private text in `needle` for local use only; it is hidden from repr, and `label` is the safe way to name a match."""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from pathlib import Path

MIN_PHRASE_CHARS = 20
MIN_PHRASE_WORDS = 3
# Markdown decoration stripped from a private line before it is judged as a phrase (jared's _MARKDOWN_LEADER_RE,
# plus the same characters at the end of the line, so a table row or a backticked line still matches plain text).
_LEADER_RE = re.compile(r"^[\s\-*>#|`]+")
_TRAILER_RE = re.compile(r"[\s|`]+$")


@dataclass(frozen=True)
class Match:
    kind: str      # "phrase" | "term"
    needle: str = field(repr=False)     # the private text itself: never print or post it
    source: str
    line: int                           # 1-based line of the scanned text where the hit begins
    label: str = ""                     # safe to print: names where the match came from, never what it said


@dataclass
class Report:
    matches: list[Match] = field(default_factory=list)
    vacuous: bool = False
    unreadable: list[str] = field(default_factory=list)   # named sources that were missing, not a file, or not strict UTF-8

    @property
    def clean(self) -> bool:
        return not self.vacuous and not self.matches


def _read(path: Path) -> str:
    """The file as text, or an OSError / UnicodeDecodeError. Strict UTF-8 (a BOM is fine); NULs mean UTF-16 or binary, not text."""
    text = path.read_text(encoding="utf-8-sig")
    if "\x00" in text:
        raise UnicodeDecodeError("utf-8", b"\x00", 0, 1, "NUL byte")
    return text


def _phrases(text: str) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for n, line in enumerate(text.splitlines(), start=1):
        cleaned = _TRAILER_RE.sub("", _LEADER_RE.sub("", line))
        if len(cleaned) >= MIN_PHRASE_CHARS and len(cleaned.split()) >= MIN_PHRASE_WORDS:
            out.append((n, cleaned))
    return out


def _has_token(term: str, text: str) -> bool:
    """True when `term` stands in `text` with a non-alphanumeric character or the text edge on each side
    (jared's _has_token): `acme` is in `acme-portal`, `acme_portal` and `Acme's`, not in `acmeology`."""
    return re.search(rf"(?<![^\W_]){re.escape(term)}(?![^\W_])", text, re.IGNORECASE) is not None


def _locate_term(text: str, words: str) -> int:
    """The 1-based line in `text` where the term `words` begins: `scan` matches a term against whitespace-flattened
    text with `_has_token`'s boundaries, so the start is found here the same way, in the original text where the
    newlines still are. `words` is bounded the way `_has_token` bounds a term, with its own tokens joined by `\\s+`
    so whitespace differences (a wrapped line, a tab) do not hide the match."""
    pattern = r"(?<![^\W_])" + r"\s+".join(re.escape(w) for w in words.split()) + r"(?![^\W_])"
    m = re.search(pattern, text, re.IGNORECASE)
    return text.count("\n", 0, m.start()) + 1 if m else 1


def _locate_phrase(text: str, words: str) -> int:
    """The 1-based line in `text` where the phrase `words` begins: `scan` matches a phrase as a plain substring of
    whitespace-flattened text, with no boundary either side (a phrase can run straight into the punctuation or the
    word that follows it in the outbound text), so the search here must stay just as unbounded or a boundary-delimited
    occurrence could miss and silently fall back to line 1. `words`' own tokens are joined by `\\s+` so whitespace
    differences (a wrapped line, a tab) do not hide the match."""
    pattern = r"\s+".join(re.escape(w) for w in words.split())
    m = re.search(pattern, text, re.IGNORECASE)
    return text.count("\n", 0, m.start()) + 1 if m else 1


def scan(text: str, sources: list[Path], terms: list[str]) -> Report:
    report = Report()
    compared = 0
    flat = " ".join(text.split())
    lowered = flat.lower()
    for src in sources:
        try:
            private = _read(src)
        except (OSError, ValueError):     # missing, a directory, unreadable, not strict UTF-8 (UnicodeDecodeError is a ValueError)
            report.unreadable.append(str(src))
            continue
        for n, phrase in _phrases(private):
            compared += 1
            if " ".join(phrase.split()).lower() in lowered:
                report.matches.append(Match("phrase", phrase, str(src), _locate_phrase(text, phrase), f"phrase from {src.name} line {n}"))
    for i, term in enumerate(terms, start=1):
        wanted = " ".join(term.split())
        if not wanted:
            continue
        compared += 1
        if _has_token(wanted, flat):
            report.matches.append(Match("term", wanted, "terms", _locate_term(text, wanted), f"term #{i}"))
    report.vacuous = compared == 0 or bool(report.unreadable)
    return report


def exit_code(report: Report) -> int:
    if report.vacuous:
        return 3
    return 1 if report.matches else 0
