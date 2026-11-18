"""Run in a disposable, disconnected Linux container with two scratch tmpfs mounts."""

import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic

import pymupdf

OWNER, VAULT_GROUP = 11001, 12001
READER, WORK_GROUP = 11002, 12002
OUTSIDER = 11003
WORK, VAULT = Path("/fixture-work"), Path("/fixture-vault")
IDENTIFIER = "ORCHID FICTIONAL"
EXPORT = """
import { readFile } from 'node:fs/promises'
import { ComputeAdmission } from './src/computeAdmission'
import { createPrivatePdfReview } from './src/redaction/privatePdfReview'

const [scratch, vaultRoot, workRoot, input, python] = JSON.parse(process.env.GIRKE_FIXTURE_PATHS)
const review = createPrivatePdfReview(new ComputeAdmission(), scratch, python, { vaultRoot, workRoot })
const prepared = await review.prepare({
  pdf: await readFile(input),
  identifiers: ['ORCHID FICTIONAL'], identifierTypes: ['PERSON'], language: 'eng',
  safeTextByPage: [['PUBLIC FICTIONAL SAMPLE']],
})
const approval = await review.approve(prepared, await review.inspect(prepared))
await review.exportApprovedCandidate(prepared, approval)
await review.discard(prepared)
console.log(prepared.candidateSha256)
"""
PROBE = """
from pathlib import Path
import sys

path = Path(sys.argv[1])
try:
    if sys.argv[2] == "read":
        sys.stdout.buffer.write(path.read_bytes())
    elif sys.argv[2] == "append":
        with path.open("ab"): pass
    else:
        list(path.iterdir())
except PermissionError:
    sys.exit(77)
"""


def staged(path, group, mode):
    path.mkdir(exist_ok=True)
    os.chown(path, OWNER, group)
    path.chmod(mode)


def probe(path, user, group, action="read"):
    return subprocess.run(
        [sys.executable, "-c", PROBE, str(path), action],
        user=user, group=group, extra_groups=[], capture_output=True, timeout=5,
    )


def exercise(umask, reader_can_read):
    started = monotonic()
    with (
        TemporaryDirectory(prefix="work-", dir=WORK) as work_dir,
        TemporaryDirectory(prefix="vault-", dir=VAULT) as vault_dir,
        TemporaryDirectory(prefix="girke-export-permissions-") as private_dir,
    ):
        work, vault, private = map(Path, (work_dir, vault_dir, private_dir))
        private.chmod(0o711)
        scratch = private / "scratch"
        staged(scratch, VAULT_GROUP, 0o700)
        staged(vault, VAULT_GROUP, 0o700)
        staged(work, WORK_GROUP, 0o2750)
        source = scratch / "fictional.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page()
            page.insert_text((60, 85), IDENTIFIER, fontsize=24)
            page.insert_text((60, 140), "PUBLIC FICTIONAL SAMPLE", fontsize=24)
            pdf.save(source)
        os.chown(source, OWNER, VAULT_GROUP)
        source.chmod(0o600)

        export = subprocess.run(
            ["bun", "--no-env-file", "--eval", EXPORT],
            user=OWNER, group=VAULT_GROUP, extra_groups=[], umask=umask,
            env={"PATH": os.environ["PATH"], "GIRKE_FIXTURE_PATHS": json.dumps(
                [str(scratch), str(vault), str(work), str(source), sys.executable]
            )}, text=True, capture_output=True, timeout=30,
        )
        assert export.returncode == 0, export.stderr
        digest = export.stdout.strip()
        assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)
        pdf_path = work / (digest + ".pdf")
        mapping = vault / digest / "mapping.json"
        assert list(work.iterdir()) == [pdf_path]
        assert list(scratch.iterdir()) == [source]
        assert list(vault.iterdir()) == [mapping.parent]
        assert list(mapping.parent.iterdir()) == [mapping]
        assert pdf_path.stat().st_gid == WORK_GROUP
        assert stat.S_IMODE(pdf_path.stat().st_mode) == (0o640 & ~umask)
        assert stat.S_IMODE(mapping.stat().st_mode) == 0o600

        read = probe(pdf_path, READER, WORK_GROUP)
        if reader_can_read:
            assert read.returncode == 0, read.stderr
            assert hashlib.sha256(read.stdout).hexdigest() == digest
            with pymupdf.open(stream=read.stdout, filetype="pdf") as exported:
                assert all(IDENTIFIER not in page.get_text() for page in exported)
        else:
            assert read.returncode == 77
        assert probe(pdf_path, READER, WORK_GROUP, "append").returncode == 77
        assert probe(pdf_path, OUTSIDER, OUTSIDER).returncode == 77
        assert probe(vault, READER, WORK_GROUP, "list").returncode == 77
        assert probe(mapping, READER, WORK_GROUP).returncode == 77
        assert probe(source, READER, WORK_GROUP).returncode == 77

        private_map = probe(mapping, OWNER, VAULT_GROUP)
        assert private_map.returncode == 0
        assert json.loads(private_map.stdout) == {
            "candidateSha256": digest, "values": {"[PERSON_1]": IDENTIFIER}
        }

    print(json.dumps({
        "umask": f"{umask:04o}", "readerCanReadApprovedPdf": reader_can_read,
        "readerCanReadMapping": False, "elapsedMs": round((monotonic() - started) * 1000),
    }))


if __name__ == "__main__":
    tmpfs = {
        row.partition(" - ")[0].split()[4]
        for row in Path("/proc/self/mountinfo").read_text().splitlines()
        if row.partition(" - ")[2].startswith("tmpfs ")
    }
    assert os.geteuid() == 0
    assert all(name == "lo" or Path(f"/sys/class/net/{name}/operstate").read_text().strip() == "down"
               for _, name in socket.if_nameindex())
    assert len(Path("/proc/net/route").read_text().splitlines()) == 1
    assert {str(WORK), str(VAULT)} <= tmpfs and WORK.stat().st_dev != VAULT.stat().st_dev
    exercise(0o027, reader_can_read=True)
    exercise(0o077, reader_can_read=False)
