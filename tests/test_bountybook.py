import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from earner.bb_worker import BBWorker, passed, supported, verify_script
from earner.bountybook import ApiError
from earner.store import Store

JOB = {"id": "job-1", "title": "Build flatten.py", "budget_usdc": "4.00", "estimated_minutes": 10,
       "job_type": "code", "description": "d",
       "spec": {"instructions": "i", "success_condition": {
           "type": "code_test", "language": "python", "test_code": "import flatten",
           "required_files": ["flatten.py"]}}}
FILES = {"flatten.py": "def f(): pass\n"}


def sandbox_result(stdout):
    content = SimpleNamespace(type="bash_code_execution_result", stdout=stdout, stderr="", return_code=0)
    return SimpleNamespace(type="bash_code_execution_tool_result", content=content)


class FakeLLM:
    """solve -> returns FILES; verify -> echoes what a real sandbox run would print."""

    def __init__(self, test_exit=0, tamper=False):
        self.test_exit, self.tamper, self.spent, self.calls = test_exit, tamper, 0.0, []

    def call(self, system, prompt, note, tools=None, schema=None, max_tokens=0, max_continuations=5,
             effort=None):
        self.calls.append(note)
        self.spent += 0.05
        if note.startswith("bb solve"):
            return SimpleNamespace(content=[], parsed={"files": [{"name": "flatten.py",
                                                                   "content": FILES["flatten.py"]}],
                                                        "notes": ""})
        marker = prompt.split('echo "')[-1].split(" EXIT")[0]
        digest = hashlib.sha256(("x" if self.tamper else FILES["flatten.py"]).encode()).hexdigest()
        out = f"{digest}  flatten.py\nok\n{marker} EXIT={self.test_exit}\n"
        return SimpleNamespace(content=[sandbox_result(out)], parsed=None)


class FakeBB:
    def __init__(self, claim_status=None, oracle_pass=True):
        self.claim_status, self.oracle_pass, self.submitted = claim_status, oracle_pass, []

    def open_jobs(self):
        return [JOB]

    def claim(self, job_id):
        if self.claim_status:
            raise ApiError(self.claim_status, "taken")

    def submit(self, job_id, files):
        self.submitted.append(files)
        return {"verification": {"passed": self.oracle_pass, "reason": "r"}, "status": "verified"}


class Helpers(unittest.TestCase):
    def test_supported(self):
        self.assertTrue(supported(JOB))
        ts = {**JOB, "spec": {"success_condition": {**JOB["spec"]["success_condition"], "language": "typescript"}}}
        self.assertFalse(supported(ts))
        self.assertFalse(supported({**JOB, "spec": {}}))
        go = {**JOB, "spec": {"success_condition": {**JOB["spec"]["success_condition"], "language": "bash",
                                                     "required_files": ["bst.go"]}}}
        self.assertFalse(supported(go))
        broken = {**JOB, "spec": {"success_condition": {**JOB["spec"]["success_condition"],
                                                         "test_code": 'x = """unterminated'}}}
        self.assertFalse(supported(broken))

    def test_passed_requires_marker_exit0_and_exact_hashes(self):
        h = hashlib.sha256(FILES["flatten.py"].encode()).hexdigest()
        self.assertTrue(passed(f"{h}\nM EXIT=0", FILES, "M"))
        self.assertFalse(passed(f"{h}\nM EXIT=1", FILES, "M"))
        self.assertFalse(passed("deadbeef\nM EXIT=0", FILES, "M"))       # different file content
        self.assertFalse(passed(f"{h}\nOTHER EXIT=0", FILES, "M"))       # marker must match

    def test_script_embeds_files_and_marker(self):
        s = verify_script(FILES, "assert True", "python", "MK")
        self.assertIn("python3 test_job.py", s)
        self.assertIn('echo "MK EXIT=$code"', s)
        self.assertIn("sha256sum 'flatten.py'", s)


class Flow(unittest.TestCase):
    def run_flow(self, llm, bb):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        st = Store(Path(d.name) / "t.db")
        self.addCleanup(st.db.close)
        BBWorker(st, bb, llm, "2026-10-10T00:00:00", 5, log=lambda *_: None).run()
        return st

    def test_verified_job_is_submitted(self):
        bb = FakeBB()
        st = self.run_flow(FakeLLM(), bb)
        self.assertEqual(bb.submitted, [FILES])
        self.assertEqual(st.submissions_since("2026-10-10", micro=True), 1)
        self.assertEqual(st.submissions_since("2026-10-10"), 0)          # doesn't eat Superteam's cap

    def test_failing_tests_never_submit(self):
        bb = FakeBB()
        st = self.run_flow(FakeLLM(test_exit=1), bb)
        self.assertEqual(bb.submitted, [])
        self.assertTrue(st.handled("bb:job-1"))                          # not re-paid next cycle

    def test_tampered_files_never_submit(self):
        bb = FakeBB()
        self.run_flow(FakeLLM(tamper=True), bb)
        self.assertEqual(bb.submitted, [])

    def test_already_claimed_skips(self):
        bb = FakeBB(claim_status=409)
        st = self.run_flow(FakeLLM(), bb)
        self.assertEqual(bb.submitted, [])
        self.assertTrue(st.handled("bb:job-1"))


if __name__ == "__main__":
    unittest.main()


class GeminiSandboxFallback(unittest.TestCase):
    def test_verify_uses_gemini_and_requires_unmodified_script(self):
        from earner import bb_worker as b

        class FakeLLM:
            down, spent, left = {"claude": "credits"}, 0.0, 5.0
            def __init__(self, tamper):
                self.tamper = tamper
            def run_python(self, code, note):
                marker = code.rsplit("'", 2)[-2].split(" EXIT=")[0] if False else code.split("print('")[-1].split(" EXIT=")[0]
                import hashlib
                h = hashlib.sha256(b"x = 1\n").hexdigest()
                return {"executed": [code + ("\n# edited" if self.tamper else "")], "output": f"{h} a.py\n{marker} EXIT=0", "usd": 0.002}

        for tamper, want in ((False, True), (True, False)):
            w = b.BBWorker.__new__(b.BBWorker)
            w.llm, w.gemini_mode = FakeLLM(tamper), True
            ok, _ = w._verify({"id": "job12345"}, {"a.py": "x = 1\n"}, "python", "assert True")
            self.assertEqual(ok, want)
