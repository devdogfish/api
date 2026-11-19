"""Linux synthetic proof using the pinned console's child entry point."""

import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import subprocess
import sys
from time import monotonic, sleep

import pymupdf

OWNER, VAULT_GROUP = 11001, 12001
READER, WORK_GROUP = 11002, 12002
OUTSIDER = 11003
SLOT = Path("/fixture")
CLI = SLOT / "scripts/prove-owner-console-restart.ts"
ENV = {"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1"}
PROBE = """
from pathlib import Path
import sys
path, operation = Path(sys.argv[1]), sys.argv[2]
try:
    if operation == "read":
        sys.stdout.buffer.write(path.read_bytes())
    elif operation == "list":
        list(path.iterdir())
    else:
        with path.open("ab"):
            pass
except PermissionError:
    sys.exit(77)
"""


def controls(uid, gid):
    return dict(user=uid, group=gid, extra_groups=[], umask=0o077, env=ENV)


def probe(path, uid, gid, operation="read"):
    return subprocess.run(
        [sys.executable, "-c", PROBE, str(path), operation],
        capture_output=True, timeout=10, **controls(uid, gid),
    )


def digest(data):
    return hashlib.sha256(data).hexdigest()


def expect_reply(child, expected):
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        assert selector.select(30), "console reply timeout"
        line = child.stdout.readline()
    assert line, f"console exited before {expected}"
    reply = json.loads(line)
    assert reply["status"] == expected, reply
    return reply.get("approvalLine")


def request(child, line):
    child.stdin.write((line + "\n").encode())
    child.stdin.flush()


def start(base, stop_after_export=False):
    cmd = ["bun", "--no-env-file", str(CLI), sys.executable, str(base)]
    if stop_after_export:
        cmd.append("suspend")
    return subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
        **controls(OWNER, VAULT_GROUP),
    )


def expect_refusal(child):
    try:
        assert child.wait(timeout=10) == 1
        assert b"Owner console scratch cannot be safely reconciled." in child.stderr.read()
    finally:
        if child.poll() is None:
            child.kill()


def prepare_fixture(new_root):
    # Assign the dedicated tmpfs mount roots to the test identities.
    scratch, vault, work = [new_root / name for name in ("scratch", "vault", "work")]
    for path, group, mode in ((scratch, VAULT_GROUP, 0o700), (vault, VAULT_GROUP, 0o700), (work, WORK_GROUP, 0o2750)):
        info = path.stat()
        assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (OWNER, group, mode)
    source = vault / "synthetic.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page(width=550, height=350)
        page.insert_text((45, 75), "PUBLIC REFERENCE", fontsize=22)
        page.insert_text((45, 145), "ORCHID VECTOR", fontsize=24)
        page.insert_text((45, 225), "END OF SAMPLE", fontsize=22)
        doc.save(source)
    source.chmod(0o600)
    os.chown(source, OWNER, VAULT_GROUP)
    assert len({scratch.stat().st_dev, vault.stat().st_dev, work.stat().st_dev}) == 3
    return scratch, vault, work, source


def main():
    assert os.geteuid() == 0
    interfaces = [name for _, name in socket.if_nameindex()]
    assert "lo" in interfaces
    assert all(
        name == "lo" or not (int(Path(f"/sys/class/net/{name}/flags").read_text().strip(), 0) & 1)
        for name in interfaces
    )
    assert len(Path("/proc/net/route").read_text().splitlines()) == 1
    assert all(fields[-1] == "lo" for line in Path("/proc/net/ipv6_route").read_text().splitlines() if (fields := line.split()))
    exporter = subprocess.check_output(
        [sys.executable, "-c", "import os; from pathlib import Path; print(os.geteuid(), os.getegid(), os.getgroups(), next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('CapEff:')))"],
        **controls(OWNER, VAULT_GROUP),
    )
    assert exporter.strip() == b"11001 12001 [] 0000000000000000"

    base = Path("/fixture-identity")
    scratch, vault, work, source = prepare_fixture(base)
    original = digest(source.read_bytes())
    with start(base) as abandoned:
        try:
            request(abandoned, "prepare")
            stale = expect_reply(abandoned, "prepared")
            _, abandoned_candidate, _, previous_nonce = stale.split()
            slot = scratch / "owner-console-session"
            abandoned_map = vault / abandoned_candidate / "mapping.json"
            assert abandoned_map.is_file() and not list(work.iterdir())
            with start(base) as concurrent:
                expect_refusal(concurrent)
                assert abandoned_map.is_file() and (slot / "preview.pdf").is_file()
            abandoned.kill()
            assert abandoned.wait(timeout=10) == -signal.SIGKILL
        finally:
            if abandoned.poll() is None:
                abandoned.kill()

    alias = slot / "untrusted-alias"
    # Create the fixture as the exporter so ownership alone cannot account for refusal.
    subprocess.run(
        [sys.executable, "-c", "import os,sys; os.symlink(sys.argv[1],sys.argv[2])", str(source), str(alias)],
        timeout=5, check=True, **controls(OWNER, VAULT_GROUP),
    )
    with start(base) as confined:
        expect_refusal(confined)
    assert alias.is_symlink() and abandoned_map.is_file()
    assert digest(source.read_bytes()) == original
    alias.unlink()

    attempt, = slot.glob("redaction-*")
    unexpected = attempt / "unrelated.txt"
    subprocess.run(
        [sys.executable, "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('unrelated')", str(unexpected)],
        timeout=5, check=True, **controls(OWNER, VAULT_GROUP),
    )
    with start(base) as confined:
        expect_refusal(confined)
    assert unexpected.read_text() == "unrelated" and abandoned_map.is_file()
    unexpected.unlink()

    parked = vault / "held-mapping.json"
    original_mapping = digest(abandoned_map.read_bytes())
    abandoned_map.rename(parked)
    subprocess.run(
        [sys.executable, "-c", "import os,sys; os.symlink(sys.argv[1],sys.argv[2])", str(parked), str(abandoned_map)],
        timeout=5, check=True, **controls(OWNER, VAULT_GROUP),
    )
    with start(base) as confined:
        expect_refusal(confined)
    assert abandoned_map.is_symlink() and digest(parked.read_bytes()) == original_mapping
    abandoned_map.unlink()
    parked.rename(abandoned_map)

    journal = slot / "prepared.json"
    recorded = journal.read_bytes()
    record = json.loads(recorded)
    journal.write_text(json.dumps({**record, "digest": "../vault"}))
    with start(base) as confined:
        expect_refusal(confined)
    assert abandoned_map.is_file()
    journal.write_text(json.dumps({**record, "vaultIno": str(int(record["vaultIno"]) + 1)}))
    with start(base) as confined:
        expect_refusal(confined)
    assert abandoned_map.is_file()
    journal.write_bytes(recorded)

    with start(base) as reconciled:
        try:
            request(reconciled, stale)
            expect_reply(reconciled, "refused")
            reconciled.stdin.close()
            assert reconciled.wait(timeout=10) == 0
        finally:
            if reconciled.poll() is None:
                reconciled.kill()
    assert not slot.exists() and not abandoned_map.exists() and not list(work.iterdir())

    with start(base, stop_after_export=True) as first:
        try:
            request(first, "prepare")
            approval = expect_reply(first, "prepared")
            _, candidate, preview_hash, nonce = approval.split()
            preview = scratch / "owner-console-session/preview.pdf"
            mapping = vault / candidate / "mapping.json"
            pdf = work / (candidate + ".pdf")
            assert not list(work.iterdir())
            assert digest(preview.read_bytes()) == preview_hash
            request(first, f"approve {candidate} {preview_hash} {previous_nonce}")
            expect_reply(first, "refused")
            assert not list(work.iterdir())
            for path in (source, preview, mapping):
                assert probe(path, READER, WORK_GROUP).returncode == 77
            assert probe(vault, READER, WORK_GROUP, "list").returncode == 77
            request(first, f"approve {candidate} {'0' * 64} {nonce}")
            expect_reply(first, "refused")
            assert not list(work.iterdir())
            mapping_sha = digest(mapping.read_bytes())
            request(first, approval)
            deadline = monotonic() + 30
            while list(work.iterdir()) != [pdf] and monotonic() < deadline:
                assert first.poll() is None
                sleep(0.02)
            assert list(work.iterdir()) == [pdf] and digest(pdf.read_bytes()) == candidate
            first.kill()
            assert first.wait(timeout=10) == -signal.SIGKILL
        finally:
            if first.poll() is None:
                first.kill()

    with start(base) as resumed:
        try:
            request(resumed, approval)
            expect_reply(resumed, "refused")
            resumed.stdin.close()
            assert resumed.wait(timeout=10) == 0
        finally:
            if resumed.poll() is None:
                resumed.kill()
    assert sorted(p.name for p in scratch.iterdir()) == [".owner-console.lock"]
    assert list(work.iterdir()) == [pdf]
    assert digest(mapping.read_bytes()) == mapping_sha
    assert digest(source.read_bytes()) == original
    assert stat.S_IMODE(mapping.stat().st_mode) == 0o600
    assert pdf.stat().st_uid == OWNER and pdf.stat().st_gid == WORK_GROUP
    assert stat.S_IMODE(pdf.stat().st_mode) == 0o640
    read = probe(pdf, READER, WORK_GROUP)
    assert read.returncode == 0 and digest(read.stdout) == candidate
    with pymupdf.open(stream=read.stdout, filetype="pdf") as exported:
        assert len(exported) == 1
        pix = exported[0].get_pixmap(dpi=150)
        ocr = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", "eng", "--psm", "11"],
            input=pix.tobytes("png"), capture_output=True, timeout=15, check=True,
            **controls(READER, WORK_GROUP),
        )
        assert b"PUBLIC REFERENCE" in ocr.stdout and b"ORCHID VECTOR" not in ocr.stdout
    assert probe(pdf, READER, WORK_GROUP, "append").returncode == 77
    assert probe(pdf, OUTSIDER, OUTSIDER).returncode == 77
    for private in (mapping, source):
        assert probe(private, READER, WORK_GROUP).returncode == 77
    orphan_slot = scratch / "owner-console-session"
    subprocess.run(
        [sys.executable, "-c", "import os,sys; os.mkdir(sys.argv[1], 0o700)", str(orphan_slot)],
        timeout=5, check=True, **controls(OWNER, VAULT_GROUP),
    )
    with start(base) as uncertain:
        expect_refusal(uncertain)
    assert orphan_slot.is_dir()
    assert digest(mapping.read_bytes()) == mapping_sha and digest(pdf.read_bytes()) == candidate
    print("linux_reader=pass separate_work_vault_scratch=1 nonroot_exporter=1 approved_digest=1 reader_append_denied=1 outsider_denied=1 vault_denied=1 retained_after_sigkill=1 abandoned_cleanup=1 active_lock=1 scratch_and_mapping_symlinks_refused=1 traversal_refused=1 incomplete_journal_preserved=1 vault_identity_bound=1 unrelated_file_preserved=1 stale_approval_refused=1", flush=True)


if __name__ == "__main__":
    main()
