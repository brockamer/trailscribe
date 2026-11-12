"""Offline tests for check.py: a fake API object, no network. Run from the repository root:

    python3 -m unittest discover -s .github/terms-check

test_preflight.py is a copy of the matcher's own tests (only its import line differs); MatcherOwnTests below runs each of
its functions, because they are written for pytest's tmp_path fixture and unittest would not collect them.

The only term used anywhere is the made-up canary below. Every run goes through `Base.run_check`, which also asserts that the
canary never reaches stdout, stderr or an alert, and that stderr is empty and stdout is exactly one allowed line.
"""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

import check
import preflight
import test_preflight

CANARY = "zebrafinch-lab-7"
OP = "operator-login"
REPO = "owner/repo"
PASS = "private-terms: pass\n"
STOP = "private-terms: stop\n"
CHANGES = "private-terms: stop (changes the checks; needs the operator)\n"
NOW = datetime(2026, 11, 11, 12, 0, 0, tzinfo=timezone.utc)
RECENT = "2026-11-11T11:30:00Z"
OLD = "2026-11-11T07:00:00Z"
P = f"/repos/{REPO}"


class FakeApi:
    """Routes map a path to a value, a list (paged by the page and per_page params) or a callable taking the params."""

    def __init__(self, routes=None, boom=False):
        self.routes = routes or {}
        self.boom = boom
        self.calls = []
        self.deleted = []

    def get(self, path, params=None):
        self.calls.append(path)
        if self.boom:
            raise RuntimeError(f"HTTP 500 for https://api.github.com{path} {CANARY}")
        value = self.routes[path]
        if callable(value):
            return value(params or {})
        if isinstance(value, list) and params and "page" in params:
            start = (params["page"] - 1) * params["per_page"]
            return value[start : start + params["per_page"]]
        return value

    def delete(self, path):
        self.deleted.append(path)


def commit(msg="fix a thing", an="Dev One", ae="dev@example.com", cn="Dev One", ce="dev@example.com", sha="c1", login=OP):
    return {
        "sha": sha,
        "commit": {"message": msg, "author": {"name": an, "email": ae}, "committer": {"name": cn, "email": ce}},
        "author": {"login": login} if login else None,
        "committer": {"login": login} if login else None,
    }


def fileent(name="src/a.ts", patch="@@ -1,2 +1,3 @@\n context\n-old\n+new line", status="modified", **kw):
    f = {"filename": name, "status": status, "additions": 1, "deletions": 1, "changes": 2}
    if patch is not None:
        f["patch"] = patch
    f.update(kw)
    return f


def pr_event(title="Add a feature", body="Does things.", ref="feature-x", author=OP, sender=OP):
    return {
        "action": "opened",
        "sender": {"login": sender},
        "pull_request": {
            "number": 7,
            "title": title,
            "body": body,
            "html_url": f"https://github.com/{REPO}/pull/7",
            "user": {"login": author},
            "head": {"ref": ref},
        },
    }


def pr_routes(commits=None, files=None):
    return {f"{P}/pulls/7/commits": commits if commits is not None else [commit()], f"{P}/pulls/7/files": files if files is not None else [fileent()]}


def comment_event(body, author=OP, sender=OP):
    return {
        "action": "created",
        "sender": {"login": sender},
        "comment": {"id": 55, "body": body, "html_url": f"https://github.com/{REPO}/issues/3#issuecomment-55", "user": {"login": author}},
        "issue": {"number": 3},
    }


def issue_event(title="A bug", body="Steps.", labels=(), author=OP, sender=OP):
    return {
        "action": "opened",
        "sender": {"login": sender},
        "issue": {
            "number": 3,
            "title": title,
            "body": body,
            "html_url": f"https://github.com/{REPO}/issues/3",
            "user": {"login": author},
            "labels": [{"name": n} for n in labels],
        },
    }


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.event_path = Path(tmp.name) / "event.json"
        self.posts = []

    def run_check(self, name, event=None, api=None, **env_over):
        if event is not None:
            self.event_path.write_text(json.dumps(event))
        env = {
            "GITHUB_REPOSITORY": REPO,
            "GITHUB_EVENT_NAME": name,
            "GITHUB_EVENT_PATH": str(self.event_path),
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_RUN_ID": "99",
            "GITHUB_TOKEN": "token",
            "PRIVATE_TERMS": f"{CANARY}\nsome other term\n",
            "PRIVATE_TERMS_ALLOW": "",
            "NTFY_TOPIC": "phone-topic",
            "TERMS_CHECK_LOGINS": f"{OP}, review-bot",
        }
        env.update(env_over)
        self.api = api or FakeApi()
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = check.main(env, api=self.api, poster=lambda u, b: self.posts.append((u, b)), now=NOW)
        self.assertEqual(err.getvalue(), "")
        self.assertIn(out.getvalue(), (PASS, STOP, CHANGES))
        self.assertNotIn(CANARY, out.getvalue() + err.getvalue())
        for url, body in self.posts:
            self.assertNotIn(CANARY, url + body)
        self.assertEqual(code, 0 if out.getvalue() == PASS else 1)
        return out.getvalue()

    def pr(self, event=None, **routes):
        return self.run_check("pull_request_target", event or pr_event(), FakeApi(pr_routes(**routes)))


class MatcherEdgeRule(Base):
    def test_edges_via_comment(self):
        for text in ("zebrafinch-lab-70x", "xzebrafinch-lab-7", "zebrafinch-lab-7x", "zebrafinch-lab-72"):
            self.posts.clear()
            self.assertEqual(self.run_check("issue_comment", comment_event(text)), PASS, text)
            self.assertEqual((self.api.deleted, self.posts), ([], []), text)
        for text in ("ZEBRAFINCH-LAB-7 was here", "see zebrafinch-lab-7_notes", "(zebrafinch-lab-7)", "Zebrafinch-Lab-7's"):
            self.assertEqual(self.run_check("issue_comment", comment_event(text)), STOP, text)

    def test_whitespace_in_a_multiword_term_is_flattened(self):
        out = self.run_check("issue_comment", comment_event("a  Some\n\tOther   Term b"), PRIVATE_TERMS="some other term")
        self.assertEqual(out, STOP)

    def test_matcher_unchanged_rule(self):
        self.assertFalse(preflight.scan("zebrafinch_notes", [], ["zebrafinch"]).clean)
        self.assertTrue(preflight.scan("zebrafinches", [], ["zebrafinch"]).clean)


class Comments(Base):
    def test_hit_deletes_and_stops_and_alerts_with_only_kind_and_url(self):
        self.assertEqual(self.run_check("issue_comment", comment_event(f"hello {CANARY}")), STOP)
        self.assertEqual(self.api.deleted, [f"{P}/issues/comments/55"])
        self.assertEqual(self.posts, [("https://ntfy.sh/phone-topic", f"private-terms stop: comment https://github.com/{REPO}/issues/3#issuecomment-55")])

    def test_clean_comment_passes(self):
        self.assertEqual(self.run_check("issue_comment", comment_event("looks good")), PASS)
        self.assertEqual((self.api.deleted, self.posts), ([], []))

    def test_triggered_by_a_judged_actor_on_a_strangers_comment(self):
        self.assertEqual(self.run_check("issue_comment", comment_event(CANARY, author="stranger", sender=OP)), STOP)
        self.assertEqual(self.api.deleted, [f"{P}/issues/comments/55"])

    def test_alert_failure_still_stops_and_deletes(self):
        def broken(url, body):
            raise OSError("ntfy down " + url)

        self.event_path.write_text(json.dumps(comment_event(CANARY)))
        out, err = io.StringIO(), io.StringIO()
        api = FakeApi()
        with redirect_stdout(out), redirect_stderr(err):
            code = check.main(
                {"GITHUB_REPOSITORY": REPO, "GITHUB_EVENT_NAME": "issue_comment", "GITHUB_EVENT_PATH": str(self.event_path),
                 "PRIVATE_TERMS": CANARY, "NTFY_TOPIC": "t", "TERMS_CHECK_LOGINS": OP},
                api=api, poster=broken, now=NOW,
            )
        self.assertEqual((code, out.getvalue(), err.getvalue()), (1, STOP, ""))
        self.assertEqual(api.deleted, [f"{P}/issues/comments/55"])

    def test_missing_ntfy_topic_still_stops(self):
        self.assertEqual(self.run_check("issue_comment", comment_event(CANARY), NTFY_TOPIC=""), STOP)
        self.assertEqual(self.posts, [])
        self.assertEqual(self.api.deleted, [f"{P}/issues/comments/55"])


class Issues(Base):
    def test_clean_issue(self):
        self.assertEqual(self.run_check("issues", issue_event(labels=["bug"])), PASS)

    def test_hit_in_title_body_label(self):
        for kw in ({"title": CANARY}, {"body": f"x {CANARY}"}, {"labels": ["ok", CANARY]}):
            self.assertEqual(self.run_check("issues", issue_event(**kw)), STOP, kw)
        self.assertEqual(self.api.deleted, [])
        self.assertIn(f"issue https://github.com/{REPO}/issues/3", self.posts[-1][1])


class PullRequests(Base):
    def test_clean_pr_from_a_judged_login_passes(self):
        self.assertEqual(self.pr(), PASS)
        self.assertEqual(self.posts, [])

    def test_canary_in_each_surface_stops(self):
        cases = {
            "added line": {"files": [fileent(patch=f"@@ -0,0 +1 @@\n+see {CANARY} here")]},
            "file path": {"files": [fileent(name=f"docs/{CANARY}.md")]},
            "previous path": {"files": [fileent(status="renamed", previous_filename=f"{CANARY}/a.md", patch=None, additions=0, deletions=0, changes=0)]},
            "commit message": {"commits": [commit(msg=f"fix {CANARY}")]},
            "author email": {"commits": [commit(ae=f"{CANARY}@example.com")]},
            "author name": {"commits": [commit(an=CANARY)]},
            "committer email": {"commits": [commit(ce=f"{CANARY}@example.com")]},
            "committer name": {"commits": [commit(cn=CANARY)]},
        }
        for label, routes in cases.items():
            self.assertEqual(self.pr(**routes), STOP, label)
        event_cases = {"branch name": {"ref": f"fix/{CANARY}"}, "title": {"title": f"Fix {CANARY}"}, "body": {"body": f"About {CANARY}"}}
        for label, kw in event_cases.items():
            self.assertEqual(self.pr(pr_event(**kw)), STOP, label)
        self.assertEqual(self.api.deleted, [])

    def test_context_and_removed_lines_are_not_scanned(self):
        patch = f"@@ -1,3 +1,3 @@\n context {CANARY}\n-removed {CANARY}\n+clean line"
        self.assertEqual(self.pr(files=[fileent(patch=patch)]), PASS)

    def test_alert_names_only_kind_and_link(self):
        self.pr(commits=[commit(msg=CANARY)])
        self.assertEqual(self.posts, [("https://ntfy.sh/phone-topic", f"private-terms stop: pull request https://github.com/{REPO}/pull/7")])

    def test_unreadable_diff_entries_stop(self):
        self.assertEqual(self.pr(files=[fileent(patch=None)]), STOP)  # binary or too large
        self.assertEqual(self.pr(files=[fileent(patch=None, status="added")]), STOP)

    def test_diff_entries_with_nothing_added_pass(self):
        removed = fileent(patch=None, status="removed", additions=0)
        renamed = fileent(patch=None, status="renamed", previous_filename="old.ts", additions=0, deletions=0, changes=0)
        self.assertEqual(self.pr(files=[removed, renamed]), PASS)

    def test_pagination_is_followed(self):
        files = [fileent(name=f"f{i}.ts") for i in range(120)]
        self.assertEqual(self.pr(files=files), PASS)
        files[-1] = fileent(name="f119.ts", patch=f"@@ -0,0 +1 @@\n+{CANARY}")
        self.assertEqual(self.pr(files=files), STOP)

    def test_api_limits_fail_closed(self):
        self.assertEqual(self.pr(commits=[commit(sha=f"c{i}") for i in range(250)]), STOP)
        self.assertEqual(self.pr(commits=[commit(sha=f"c{i}") for i in range(249)]), PASS)
        self.assertEqual(self.pr(files=[fileent(name=f"f{i}.ts") for i in range(3000)]), STOP)

    def test_github_and_claude_paths_from_a_judged_login(self):
        for name in (".github/workflows/x.yml", ".claude/settings.json", ".GitHub/terms-check/check.py"):
            self.assertEqual(self.pr(files=[fileent(name=name)]), CHANGES, name)
        self.posts.clear()
        self.assertEqual(self.pr(files=[fileent(name="docs/.github-notes.md"), fileent(name="src/.claude.ts")]), PASS)
        self.assertEqual(self.posts, [])

    def test_github_path_from_a_stranger_is_a_plain_pass(self):
        ev = pr_event(author="stranger", sender="stranger")
        out = self.run_check("pull_request_target", ev, FakeApi(pr_routes(files=[fileent(name=".github/workflows/x.yml")])))
        self.assertEqual(out, PASS)


class Gate(Base):
    def test_empty_terms_is_a_stop(self):
        for terms in ("", "  \n\n\t\n"):
            self.assertEqual(self.pr(), PASS)  # sanity: default terms pass a clean PR
            self.assertEqual(self.run_check("pull_request_target", pr_event(), FakeApi(pr_routes()), PRIVATE_TERMS=terms), STOP, repr(terms))

    def test_everything_allow_listed_leaves_nothing_to_compare(self):
        self.assertEqual(self.run_check("issue_comment", comment_event("hello"), PRIVATE_TERMS="Op Name", PRIVATE_TERMS_ALLOW="op  name"), STOP)

    def test_allow_listed_term_passes_and_others_still_stop(self):
        terms = f"{CANARY}\nOperator Name"
        allow = "  operator   NAME \n"
        ok = self.run_check("pull_request_target", pr_event(), FakeApi(pr_routes(commits=[commit(an="Operator Name", cn="operator name")])), PRIVATE_TERMS=terms, PRIVATE_TERMS_ALLOW=allow)
        self.assertEqual(ok, PASS)
        bad = self.run_check("pull_request_target", pr_event(), FakeApi(pr_routes(commits=[commit(an="Operator Name", msg=CANARY)])), PRIVATE_TERMS=terms, PRIVATE_TERMS_ALLOW=allow)
        self.assertEqual(bad, STOP)

    def test_empty_logins_is_a_stop(self):
        for logins in ("", " , "):
            self.assertEqual(self.run_check("issue_comment", comment_event("hi", author="stranger", sender="stranger"), TERMS_CHECK_LOGINS=logins), STOP)

    def test_logins_may_be_comma_or_space_separated_and_case_insensitive(self):
        self.assertEqual(self.run_check("issue_comment", comment_event(CANARY, author="Some-Bot"), TERMS_CHECK_LOGINS="x,some-bot y"), STOP)

    def test_unknown_event_or_unreadable_event_is_a_stop(self):
        self.assertEqual(self.run_check("push", {"x": 1}), STOP)
        self.assertEqual(self.run_check("issue_comment", {"no": "comment"}), STOP)


class Strangers(Base):
    def test_unjudged_author_with_the_canary_is_byte_identical_to_a_clean_judged_run(self):
        clean = self.run_check("issue_comment", comment_event("a perfectly clean comment"))
        stranger = self.run_check("issue_comment", comment_event(f"{CANARY} guess", author="stranger", sender="stranger"))
        self.assertEqual(stranger, clean)
        self.assertEqual(stranger, PASS)
        self.assertEqual((self.api.deleted, self.api.calls, self.posts), ([], [], []))

    def test_unjudged_pr_and_issue_are_untouched(self):
        ev = pr_event(title=CANARY, author="stranger", sender="stranger")
        self.assertEqual(self.run_check("pull_request_target", ev, FakeApi()), PASS)
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.run_check("issues", issue_event(body=CANARY, author="stranger", sender="stranger")), PASS)

    def test_a_stranger_run_does_not_depend_on_the_term_list(self):
        self.assertEqual(self.run_check("issue_comment", comment_event("x", author="stranger", sender="stranger"), PRIVATE_TERMS=""), PASS)


class Failures(Base):
    def test_forced_exception_gives_a_bare_stop(self):
        out = self.run_check("pull_request_target", pr_event(), FakeApi(boom=True))
        self.assertEqual(out, STOP)

    def test_delete_failure_still_stops_and_alerts(self):
        class NoDelete(FakeApi):
            def delete(self, path):
                raise RuntimeError(CANARY)

        self.assertEqual(self.run_check("issue_comment", comment_event(CANARY), NoDelete()), STOP)
        self.assertEqual(len(self.posts), 1)

    def test_broken_matcher_import_is_a_stop(self):
        saved, check.preflight = check.preflight, None
        try:
            self.assertEqual(self.run_check("issue_comment", comment_event("hi")), STOP)
        finally:
            check.preflight = saved

    def test_nothing_leaks_outside_the_single_line_even_if_the_code_prints(self):
        class Chatty(FakeApi):
            def get(self, path, params=None):
                print("noise " + CANARY)
                import sys

                print("noise", file=sys.stderr)
                return super().get(path, params)

        self.assertEqual(self.run_check("pull_request_target", pr_event(), Chatty(pr_routes())), PASS)


def sweep_routes(**over):
    routes = {
        f"{P}/issues/comments": [],
        f"{P}/pulls": lambda params: [] if params.get("state") == "open" else [{"number": 7, "updated_at": RECENT, "head": {"ref": "b"}}],
        f"{P}/pulls/7/reviews": [],
        f"{P}/pulls/7/comments": [],
        P: {"default_branch": "main"},
        f"{P}/branches": [{"name": "main", "commit": {"sha": "m0"}}],
    }
    routes.update(over)
    return routes


def review_comment(body, login=OP, updated=RECENT):
    return {"id": 77, "body": body, "user": {"login": login}, "updated_at": updated, "html_url": f"https://github.com/{REPO}/pull/7#discussion_r77"}


class Sweep(Base):
    def sweep(self, **over):
        return self.run_check("schedule", None, FakeApi(sweep_routes(**over)))

    def test_clean_sweep_passes(self):
        self.assertEqual(self.sweep(), PASS)

    def test_review_line_comment_hit_is_deleted(self):
        self.assertEqual(self.sweep(**{f"{P}/pulls/7/comments": [review_comment(f"nit {CANARY}")]}), STOP)
        self.assertEqual(self.api.deleted, [f"{P}/pulls/comments/77"])
        self.assertEqual(self.posts, [("https://ntfy.sh/phone-topic", f"private-terms stop: review comment https://github.com/{REPO}/pull/7#discussion_r77")])

    def test_unjudged_or_old_review_comments_are_ignored(self):
        self.assertEqual(self.sweep(**{f"{P}/pulls/7/comments": [review_comment(CANARY, login="stranger"), review_comment(CANARY, updated=OLD)]}), PASS)
        self.assertEqual(self.api.deleted, [])

    def test_review_summary_hit_stops_without_delete(self):
        review = {"id": 5, "body": CANARY, "user": {"login": "review-bot"}, "submitted_at": RECENT, "html_url": f"https://github.com/{REPO}/pull/7#pullrequestreview-5"}
        self.assertEqual(self.sweep(**{f"{P}/pulls/7/reviews": [review]}), STOP)
        self.assertEqual(self.api.deleted, [])
        self.assertEqual(len(self.posts), 1)

    def test_a_missed_conversation_comment_is_deleted(self):
        c = {"id": 9, "body": CANARY, "user": {"login": OP}, "html_url": f"https://github.com/{REPO}/issues/3#issuecomment-9"}
        self.assertEqual(self.sweep(**{f"{P}/issues/comments": [c]}), STOP)
        self.assertEqual(self.api.deleted, [f"{P}/issues/comments/9"])

    def branch_routes(self, commits, files=None, committed=RECENT, name="work", **extra):
        routes = {
            f"{P}/branches": [{"name": "main", "commit": {"sha": "m0"}}, {"name": name, "commit": {"sha": "b1"}}],
            f"{P}/commits/b1": {"commit": {"committer": {"date": committed}}},
            f"{P}/compare/m0...b1": lambda params: {
                "commits": commits if params["page"] == 1 else [],
                "files": (files or [])[(params["page"] - 1) * params["per_page"] : params["page"] * params["per_page"]],
                "total_commits": len(commits),
            },
        }
        routes.update(extra)
        return routes

    def test_branch_without_a_pr_is_scanned(self):
        clean = self.sweep(**self.branch_routes([commit()], [fileent()]))
        self.assertEqual(clean, PASS)
        for label, kw in {
            "message": dict(commits=[commit(msg=CANARY)]),
            "email": dict(commits=[commit(ae=f"{CANARY}@example.com")]),
            "line": dict(commits=[commit()], files=[fileent(patch=f"@@ -0,0 +1 @@\n+{CANARY}")]),
            "path": dict(commits=[commit()], files=[fileent(name=f"{CANARY}.txt")]),
            "branch": dict(commits=[commit()], name=f"wip/{CANARY}"),
        }.items():
            self.posts.clear()
            self.assertEqual(self.sweep(**self.branch_routes(**kw)), STOP, label)
            self.assertEqual(self.posts[0][1], f"private-terms stop: branch https://github.com/{REPO}/commit/b1", label)
        self.assertEqual(self.api.deleted, [])

    def test_branch_with_an_unreadable_diff_entry_stops(self):
        self.assertEqual(self.sweep(**self.branch_routes([commit()], [fileent(patch=None)])), STOP)

    def test_compare_that_may_be_truncated_is_a_stop(self):
        many = [fileent(name=f"f{i}.ts") for i in range(300)]
        self.assertEqual(self.sweep(**self.branch_routes([commit()], many)), STOP)
        self.assertEqual(self.sweep(**self.branch_routes([commit()], many[:299])), PASS)
        short = self.branch_routes([commit()], [fileent()])
        listed = short[f"{P}/compare/m0...b1"]
        for total in (2, None):  # the response says a second commit exists that was not listed, or says nothing
            short[f"{P}/compare/m0...b1"] = lambda params, total=total: dict(listed(params), total_commits=total)
            self.assertEqual(self.sweep(**short), STOP, total)

    def test_old_branches_and_branches_with_an_open_pr_are_skipped(self):
        self.assertEqual(self.sweep(**self.branch_routes([commit(msg=CANARY)], committed=OLD)), PASS)
        open_pr = [{"number": 8, "head": {"ref": "work", "repo": {"full_name": REPO}}}]
        routes = self.branch_routes([commit(msg=CANARY)])
        routes[f"{P}/pulls"] = lambda params: open_pr if params.get("state") == "open" else []
        self.assertEqual(self.sweep(**routes), PASS)

    def test_branch_by_a_stranger_login_is_not_judged_but_an_unlinked_one_is(self):
        self.assertEqual(self.sweep(**self.branch_routes([commit(msg=CANARY, login="stranger")])), PASS)
        self.assertEqual(self.sweep(**self.branch_routes([commit(msg=CANARY, login=None)])), STOP)

    def test_sweep_with_empty_terms_is_a_stop(self):
        self.assertEqual(self.run_check("workflow_dispatch", None, FakeApi(sweep_routes()), PRIVATE_TERMS=""), STOP)

    def test_sweep_api_error_is_a_stop(self):
        self.assertEqual(self.run_check("schedule", None, FakeApi({})), STOP)


class WorkflowFile(unittest.TestCase):
    """Trap 1 and the fixed names, checked on the workflow text itself."""

    def setUp(self):
        self.text = (Path(__file__).resolve().parents[1] / "workflows" / "terms-check.yml").read_text()

    def test_no_event_text_anywhere(self):
        self.assertNotIn("github.event", self.text.replace("github.event_name", ""))

    def test_job_name_checkout_and_permissions(self):
        self.assertIn("\n  private-terms:\n", self.text)
        self.assertIn("environment: private-terms", self.text)
        self.assertIn("persist-credentials: false", self.text)
        for line in ("contents: read", "issues: write", "pull-requests: write"):
            self.assertIn(line, self.text)
        self.assertEqual(self.text.count(": write"), 2)
        self.assertNotIn("ref:", self.text)  # default ref only: never the pull request's head


class MatcherOwnTests(unittest.TestCase):
    """Runs the copied matcher tests (pytest-style functions) here, so the plain-unittest lane covers them."""

    def test_copied_matcher_tests(self):
        import inspect

        ran = 0
        for name, fn in sorted(vars(test_preflight).items()):
            if not (name.startswith("test_") and callable(fn)):
                continue
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                fn(*([Path(tmp)] if "tmp_path" in inspect.signature(fn).parameters else []))
            ran += 1
        self.assertGreaterEqual(ran, 24)


if __name__ == "__main__":
    unittest.main()
