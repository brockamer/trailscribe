#!/usr/bin/env python3
"""Private-terms check for this public repository.

Run by .github/workflows/terms-check.yml. Compares text the repository owner's login (or a listed bot) publishes here with a
private term list held in the `private-terms` environment, using preflight.py, which is copied unchanged from the author's own
tooling. Standard library only. Nothing in this file may name a private term: the only term used in tests is a made-up canary.

SECRETS. PRIVATE_TERMS (one term per line) and PRIVATE_TERMS_ALLOW (terms this repository may publish, one per line, optional)
are each stored as ONE base64 line, so the runner's log masking (it masks a multi-line secret whole and line by line, and masks
substrings) cannot turn a term that also appears in other log text into "***" and give it away by a diff. Upload with:
    base64 -w0 private-terms.txt | gh secret set PRIVATE_TERMS --env private-terms --repo <owner>/<repo>
Invalid base64 or text that is not UTF-8 is a stop. NTFY_TOPIC is a plain secret.

PUBLIC-LOG RULE. The whole run prints exactly one line to stdout and nothing to stderr:
    private-terms: pass
    private-terms: stop
    private-terms: stop (changes the checks; needs the operator)      (only for a pull request touching .github/ or .claude/)
Exit 0 for pass, 1 for stop. Any exception, API error, partial read or misconfiguration is a stop; its message and traceback
are never printed, because an HTTP error can carry a URL with a branch name and a traceback can carry text. The event is read
from GITHUB_EVENT_PATH; no event text is ever put in the workflow's run:, env: or with: (Actions echoes those into the log).

WHO IS JUDGED. Decided here, not by a job-level `if:`. Content counts when its author is in TERMS_CHECK_LOGINS. Anything else
gives the same single "pass" line as a clean scan, with no comparison against the terms, so a stranger cannot test guesses.
Exceptions, each deliberate:
- A pull request touching .github/ or .claude/ is a stop whoever wrote it, so a stranger's fork PR cannot change the check and
  get a green required check. The path guard reads only the PR's file list; it never loads or compares terms for a stranger.
- When a judged login edits a stranger's issue, pull request or comment, only the edited text (title and body, or the comment
  body) is judged, and a judged login's label on a stranger's issue is judged: that is the operator's own publication.
- Commits a judged login pushes onto a stranger's pull request are NOT judged. Commit author and committer emails can be forged
  to look like the operator, which would turn a stranger's PR red on demand and give them a way to probe the list.
An empty TERMS_CHECK_LOGINS, or an empty term list after the allow list, is a stop.

FAIL CLOSED. Unread text is never a pass: see `_no_patch_is_harmless` for the rule on diff entries without a patch, `_paged` for
list limits (250 commits and 3000 files on a pull request; a page that is not a list), and MAX_REQUESTS for the per-run budget.

WHAT IS READ. For a judged pull request: title, body, branch name, fresh from the API; every commit's message, author and
committer name and email, and each commit's own diff (added lines and paths), so a term added in one commit and removed in the
next is still caught; and the net diff. The hourly sweep (also run by hand with workflow_dispatch) looks back 26 hours, so a
missed or failed run leaves nothing unread, and re-reads: conversation comments, titles and bodies of issues and pull requests,
review summaries, review line comments, commit comments, every tag name, and every branch that has no open pull request and
differs from the default branch (no date filter; more than 100 such branches is a stop).

NOT COVERED: wiki, discussions, releases, gists, CI logs, the cloud session's transcript, annotated tag messages, and an edited
review summary (the API exposes no edit time, so only a summary submitted inside the sweep window is read). A review summary,
a title or body, a tag or a branch cannot be deleted through this check: a hit there is a stop and an alert, cleaned by hand.
A stranger's pull request with 3000 or more files cannot be fully read for the path guard, so it is a stop, not a pass.
"""
import base64
import binascii
import contextlib
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    import preflight
except Exception:  # a missing or broken matcher must end as a stop, never as a traceback
    preflight = None

PASS_LINE = "private-terms: pass"
STOP_LINE = "private-terms: stop"
STOP_CHANGES_LINE = "private-terms: stop (changes the checks; needs the operator)"

PER_PAGE = 100
MAX_PR_COMMITS = 250  # the pull request commits endpoint stops listing here
MAX_PR_FILES = 3000  # and the files endpoint here
MAX_COMPARE_FILES = 300  # the compare endpoint lists at most this many files; at the cap the list may be cut short
MAX_COMMIT_FILES = 300  # so does the single-commit endpoint
MAX_LIST = 300  # bound for every other list the check pages through
MAX_BRANCHES = 100  # branches to sweep; more than this is a stop
MAX_TAGS = 100
MAX_REQUESTS = 900  # GitHub allows 1000 an hour to the workflow token; past this the read is incomplete
MAX_PAGES = 31
SWEEP_WINDOW = timedelta(hours=26)
PROTECTED_DIRS = {".github", ".claude"}


class Incomplete(RuntimeError):
    """Something could not be read in full. Never printed; it ends the run as a stop."""


# ---- terms -------------------------------------------------------------------------------------------------------------


def _normalized(s):
    """Case-insensitive, whitespace-normalised: how the allow list is compared (the same rule as the author's outbound_ok)."""
    return " ".join(s.split()).casefold()


def _decode_secret(raw):
    """A secret stored as one base64 line, decoded as strict UTF-8 (a byte-order mark is fine). Empty decodes to empty."""
    raw = "".join((raw or "").split())
    if not raw:
        return ""
    try:
        text = base64.b64decode(raw, validate=True).decode("utf-8-sig")
    except (binascii.Error, ValueError):  # UnicodeDecodeError is a ValueError
        raise Incomplete
    if "\x00" in text:
        raise Incomplete  # UTF-16 or binary: its terms could never match
    return text


def load_terms(raw, allow_raw):
    """One term per line, minus the allow-listed ones (exact term, case-folded, whitespace-normalised). Both arguments are
    the base64 secrets. Nothing left to compare is a stop, never a pass."""
    text = _decode_secret(raw)
    allowed = {_normalized(a) for a in _decode_secret(allow_raw).splitlines()}
    terms = [t for t in text.splitlines() if t.strip() and _normalized(t) not in allowed]
    if not terms:
        raise Incomplete
    return terms


def parse_logins(raw):
    logins = {x.lower() for x in (raw or "").replace(",", " ").split()}
    if not logins:
        raise Incomplete  # misconfigured: judging nobody must not look like a pass
    return logins


def _login(obj):
    return ((obj or {}).get("login") or "").lower() or None


def _protected(path):
    return bool(path) and path.replace("\\", "/").lstrip("/").casefold().split("/")[0] in PROTECTED_DIRS


def _added_lines(patch):
    """Only the lines a patch adds, as one text. Context and removed lines are not new publication."""
    return "\n".join(line[1:] for line in patch.split("\n") if line.startswith("+"))


def _no_patch_is_harmless(f):
    """The API leaves `patch` out for binary files, over-large diffs and pure renames. A removed file adds nothing, and a
    rename, copy or mode change with no line changes adds no text. Anything else (an added or modified file without a patch)
    was not read, so it is a stop. This also stops a PR that adds or changes a binary file such as a PDF or an image."""
    if f.get("status") == "removed":
        return True
    quiet = not (f.get("additions") or f.get("deletions") or f.get("changes"))
    return quiet and f.get("status") in ("renamed", "copied", "changed", "unchanged")


def _ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---- GitHub, ntfy ------------------------------------------------------------------------------------------------------


class Api:
    """The two GitHub calls the check makes. Tests inject an object with the same get/delete methods."""

    def __init__(self, token, base="https://api.github.com"):
        self.token = token
        self.base = base.rstrip("/")

    def _call(self, method, path, params=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        req = urllib.request.Request(
            url,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "terms-check",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        return json.loads(data) if data else None

    def get(self, path, params=None):
        return self._call("GET", path, params)

    def delete(self, path):
        return self._call("DELETE", path)


def _post(url, body):
    req = urllib.request.Request(url, data=body.encode("utf-8"), method="POST", headers={"Title": "private-terms stop"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


# ---- the run -----------------------------------------------------------------------------------------------------------


class Run:
    def __init__(self, env, api, poster, now):
        self.env = env
        self.api = api
        self.poster = poster
        self.now = now
        self.repo = env.get("GITHUB_REPOSITORY", "")
        self.server = env.get("GITHUB_SERVER_URL") or "https://github.com"
        self.logins = set()
        self.terms = None
        self.hits = []  # (kind of surface, html_url, API path to delete or None)
        self.checks_changed = False
        self.failed = False
        self.requests = 0
        self._commit_diffs = {}  # sha -> that commit's files, so a commit shared by several branches is read once

    # -- judging and matching
    def judged(self, *logins):
        return any(x and x.lower() in self.logins for x in logins)

    def arm(self):
        """Load the term list. Called only once something is judged, so a stranger's run never depends on it."""
        if self.terms is None:
            if preflight is None:
                raise Incomplete
            self.terms = load_terms(self.env.get("PRIVATE_TERMS"), self.env.get("PRIVATE_TERMS_ALLOW"))

    def dirty(self, text):
        """True on a hit. Not clean (a hit, or a scan with nothing to compare) is not a pass."""
        if not text:
            return False
        return not preflight.scan(text, [], self.terms).clean

    def hit(self, kind, url, delete=None):
        self.hits.append((kind, url, delete))

    def commit_url(self, sha):
        return f"{self.server}/{self.repo}/commit/{sha}"

    # -- reading
    def _get(self, path, params=None):
        self.requests += 1
        if self.requests > MAX_REQUESTS:
            raise Incomplete
        return self.api.get(path, params)

    def _paged(self, path, params=None, cap=MAX_LIST):
        """Every item of a list endpoint. At the cap, with no end in sight, or with a page that is not a list, the list may be
        longer than what was read: that is Incomplete, not a pass. `cap` is the first count that is too many."""
        out = []
        for page in range(1, MAX_PAGES):
            chunk = self._get(path, dict(params or {}, per_page=PER_PAGE, page=page))
            if not isinstance(chunk, list):
                raise Incomplete
            out.extend(chunk)
            if len(out) >= cap:
                raise Incomplete
            if len(chunk) < PER_PAGE:
                return out
        raise Incomplete

    def _scan_files(self, files, protect):
        """Diff entries: paths (new and previous) and added lines. With `protect`, a path under .github/ or .claude/ marks the
        run as one that changes the checks."""
        found = False
        for f in files:
            names = [f.get("filename"), f.get("previous_filename")]
            if protect and any(_protected(n) for n in names):
                self.checks_changed = True
            found |= any([self.dirty(n) for n in names])
            patch = f.get("patch")
            if patch is None:
                if not _no_patch_is_harmless(f):
                    raise Incomplete
            elif isinstance(patch, str):
                found |= self.dirty(_added_lines(patch))
            else:
                raise Incomplete
        return found

    def _commit_files(self, sha):
        if sha not in self._commit_diffs:
            detail = self._get(f"/repos/{self.repo}/commits/{sha}")
            files = detail.get("files") if isinstance(detail, dict) else None
            if not isinstance(files, list) or len(files) >= MAX_COMMIT_FILES:
                raise Incomplete
            self._commit_diffs[sha] = files
        return self._commit_diffs[sha]

    def _scan_commits(self, commits, protect):
        """Each commit's message, author and committer name and email, and its own diff."""
        found = False
        for c in commits:
            cm = c.get("commit") or {}
            texts = [cm.get("message")]
            for who in ("author", "committer"):
                texts += [(cm.get(who) or {}).get("name"), (cm.get(who) or {}).get("email")]
            found |= any([self.dirty(t) for t in texts])
            found |= self._scan_files(self._commit_files(c["sha"]), protect)
        return found

    # -- event surfaces
    def on_issue(self, ev):
        issue = ev["issue"]
        action = ev.get("action")
        sender_judged = self.judged(_login(ev.get("sender")))
        if self.judged(_login(issue.get("user"))):
            texts = [issue.get("title"), issue.get("body")] + [(lb or {}).get("name") for lb in issue.get("labels") or []]
        elif sender_judged and action == "edited":
            texts = [issue.get("title"), issue.get("body")]
        elif sender_judged and action == "labeled":
            texts = [(ev.get("label") or {}).get("name")]
        else:
            return
        self.arm()
        if any([self.dirty(t) for t in texts]):
            self.hit("issue", issue["html_url"])

    def on_comment(self, ev):
        c = ev["comment"]
        edited_by_judged = ev.get("action") == "edited" and self.judged(_login(ev.get("sender")))
        if not (self.judged(_login(c.get("user"))) or edited_by_judged):
            return
        self.arm()
        if self.dirty(c.get("body")):
            self.hit("comment", c["html_url"], f"/repos/{self.repo}/issues/comments/{c['id']}")

    def on_pull_request(self, ev):
        pr = ev["pull_request"]
        n, url = pr["number"], pr["html_url"]
        author_judged = self.judged(_login(pr.get("user")))
        edit_judged = ev.get("action") == "edited" and self.judged(_login(ev.get("sender")))
        # The file list is read for every pull request: the path guard does not depend on who wrote it.
        files = self._paged(f"/repos/{self.repo}/pulls/{n}/files", cap=MAX_PR_FILES)
        found = False
        if author_judged or edit_judged:
            self.arm()
            fresh = self._get(f"/repos/{self.repo}/pulls/{n}")
            texts = [fresh.get("title"), fresh.get("body")]
            if author_judged:
                texts.append((fresh.get("head") or {}).get("ref"))
            found = any([self.dirty(t) for t in texts])
        if author_judged:
            commits = self._paged(f"/repos/{self.repo}/pulls/{n}/commits", cap=MAX_PR_COMMITS)
            found |= self._scan_commits(commits, protect=True)
            found |= self._scan_files(files, protect=True)
        else:
            self.checks_changed |= any(_protected(f.get("filename")) or _protected(f.get("previous_filename")) for f in files)
        if found:
            self.hit("pull request", url)
        if self.checks_changed:
            self.hit("pull request that changes the checks", url)

    # -- the hourly sweep
    def sweep(self):
        self.arm()
        repo = self.repo
        cutoff = self.now - SWEEP_WINDOW
        since = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")

        # Conversation comments an event may have missed.
        for c in self._paged(f"/repos/{repo}/issues/comments", {"since": since}):
            if self.judged(_login(c.get("user"))) and self.dirty(c.get("body")):
                self.hit("comment", c["html_url"], f"/repos/{repo}/issues/comments/{c['id']}")

        # Titles and bodies of issues and pull requests updated in the window (the issues list holds both kinds).
        for i in self._paged(f"/repos/{repo}/issues", {"state": "all", "since": since}):
            if self.judged(_login(i.get("user"))):
                texts = [i.get("title"), i.get("body")] + [(lb or {}).get("name") for lb in i.get("labels") or []]
                if any([self.dirty(t) for t in texts]):
                    self.hit("pull request" if "pull_request" in i else "issue", i["html_url"])

        # Review summaries (cannot be deleted by API) and review line comments (can be) on recently updated pull requests.
        for pr in self._recent_pulls(cutoff):
            n = pr["number"]
            for r in self._paged(f"/repos/{repo}/pulls/{n}/reviews"):
                if r.get("submitted_at") and _ts(r["submitted_at"]) >= cutoff:
                    if self.judged(_login(r.get("user"))) and self.dirty(r.get("body")):
                        self.hit("review", r["html_url"])
            for c in self._paged(f"/repos/{repo}/pulls/{n}/comments", {"since": since}):
                if _ts(c["updated_at"]) >= cutoff and self.judged(_login(c.get("user"))) and self.dirty(c.get("body")):
                    self.hit("review comment", c["html_url"], f"/repos/{repo}/pulls/comments/{c['id']}")

        # Commit comments.
        for c in self._paged(f"/repos/{repo}/comments"):
            if _ts(c["updated_at"]) >= cutoff and self.judged(_login(c.get("user"))) and self.dirty(c.get("body")):
                self.hit("commit comment", c["html_url"], f"/repos/{repo}/comments/{c['id']}")

        # Tags: only collaborators can push them, so every tag is judged. The alert links the commit, not the name.
        for t in self._paged(f"/repos/{repo}/tags", cap=MAX_TAGS + 1):
            if self.dirty(t.get("name")):
                self.hit("tag", self.commit_url(t["commit"]["sha"]))

        # Branches that have no open pull request (an open one is covered by its own event) and differ from the default.
        default = self._get(f"/repos/{repo}")["default_branch"]
        branches = self._paged(f"/repos/{repo}/branches")
        base = next(b["commit"]["sha"] for b in branches if b["name"] == default)
        open_heads = set()
        for pr in self._paged(f"/repos/{repo}/pulls", {"state": "open"}):
            head = pr.get("head") or {}
            if ((head.get("repo") or {}).get("full_name") or "").lower() == repo.lower():
                open_heads.add(head.get("ref"))
        todo = [b for b in branches if b["name"] != default and b["name"] not in open_heads and b["commit"]["sha"] != base]
        if len(todo) > MAX_BRANCHES:
            raise Incomplete
        for b in todo:
            sha = b["commit"]["sha"]
            commits, files = self._compare(base, sha)
            # Only people with write access push branches here, so a commit with no linked login is judged too.
            if not any(self.judged(_login(c.get("author")), _login(c.get("committer"))) or not _login(c.get("author")) for c in commits):
                continue
            found = self.dirty(b["name"])
            found |= self._scan_commits(commits, protect=False)
            found |= self._scan_files(files, protect=False)
            if found:
                # The alert link is the commit, not the branch: a branch name could itself hold a term.
                self.hit("branch", self.commit_url(sha))

    def _recent_pulls(self, cutoff):
        out = []
        for page in range(1, 4):
            chunk = self._get(
                f"/repos/{self.repo}/pulls",
                {"state": "all", "sort": "updated", "direction": "desc", "per_page": PER_PAGE, "page": page},
            )
            if not isinstance(chunk, list):
                raise Incomplete
            for pr in chunk:
                if _ts(pr["updated_at"]) < cutoff:
                    return out
                out.append(pr)
            if len(chunk) < PER_PAGE:
                return out
        raise Incomplete

    def _compare(self, base, head):
        commits, files = {}, {}
        for page in range(1, MAX_PAGES):
            r = self._get(f"/repos/{self.repo}/compare/{base}...{head}", {"per_page": PER_PAGE, "page": page})
            if not isinstance(r, dict):
                raise Incomplete
            cs, fs = r.get("commits") or [], r.get("files") or []
            for c in cs:
                commits[c["sha"]] = c
            for f in fs:
                files[f["filename"]] = f
            if len(commits) >= MAX_PR_COMMITS or len(files) >= MAX_COMPARE_FILES:
                raise Incomplete
            if len(cs) < PER_PAGE and len(fs) < PER_PAGE:
                # The compare endpoint may cap or not page its file list, so a list that reaches the cap is a stop, and the
                # commits read must equal the commits the response says exist.
                if r.get("total_commits") != len(commits):
                    raise Incomplete
                return list(commits.values()), list(files.values())
        raise Incomplete

    # -- finishing
    def collect(self):
        self.logins = parse_logins(self.env.get("TERMS_CHECK_LOGINS"))
        name = self.env.get("GITHUB_EVENT_NAME")
        if name in ("schedule", "workflow_dispatch"):
            self.sweep()
            return
        with open(self.env["GITHUB_EVENT_PATH"], encoding="utf-8") as fh:
            ev = json.load(fh)
        handler = {"issues": self.on_issue, "issue_comment": self.on_comment, "pull_request_target": self.on_pull_request}.get(name)
        if handler is None:
            raise Incomplete
        handler(ev)

    def alert(self, kind, url):
        """Phone alert: the kind of surface and its link, never the term, its number or a line. A failure here never turns a
        stop into a pass."""
        topic = (self.env.get("NTFY_TOPIC") or "").strip()
        if not topic:
            return
        try:
            self.poster("https://ntfy.sh/" + urllib.parse.quote(topic, safe=""), f"private-terms stop: {kind} {url}")
        except Exception:
            pass

    def go(self):
        try:
            self.collect()
        except Exception:
            self.failed = True
        for kind, url, delete in self.hits:  # act on what was found even if a later read failed
            deleted = True
            if delete:
                try:
                    self.api.delete(delete)
                except Exception:
                    deleted = False
            self.alert(kind if deleted else kind + " (could not delete)", url)
        if self.failed and not self.hits:
            self.alert("check could not finish", f"{self.server}/{self.repo}/actions/runs/{self.env.get('GITHUB_RUN_ID', '')}")
        if self.checks_changed:
            return STOP_CHANGES_LINE
        return STOP_LINE if (self.failed or self.hits) else PASS_LINE


def main(environ=None, api=None, poster=None, now=None):
    env = os.environ if environ is None else environ
    real_out = sys.stdout
    line = STOP_LINE
    try:
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            run = Run(
                env,
                api or Api(env.get("GITHUB_TOKEN", ""), env.get("GITHUB_API_URL") or "https://api.github.com"),
                poster or _post,
                now or datetime.now(timezone.utc),
            )
            line = run.go()
    except Exception:
        line = STOP_LINE
    real_out.write(line + "\n")
    real_out.flush()
    return 0 if line == PASS_LINE else 1


if __name__ == "__main__":
    sys.exit(main())
