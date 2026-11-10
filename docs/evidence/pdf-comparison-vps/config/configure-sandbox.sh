#!/bin/bash
set -euo pipefail
cd /var/tmp/timekeeper-pdf-vps-01a1c539
cp seccomp_profile.json seccomp_profile.upstream.json
python3 - <<'PY'
import json
from pathlib import Path

upstream = json.loads(Path("seccomp_profile.upstream.json").read_text())
chroot_rule, = (rule for rule in upstream["syscalls"] if "chroot" in rule["names"])
assert chroot_rule["names"] == ["chroot"]
assert chroot_rule["includes"] == {"caps": ["CAP_SYS_CHROOT"]}
chroot_rule["includes"] = {}
Path("seccomp_profile.json").write_text(json.dumps(upstream, indent=2) + "\n")
PY
sha256sum seccomp_profile.upstream.json seccomp_profile.json > logs/seccomp.sha256
mv logs/runtime.txt logs/runtime-profile-initial.txt
mv logs/smoke-container-id.txt logs/smoke-container-profile-initial-id.txt
docker rm timekeeper-pdf-vps-smoke-01a1c539 > logs/smoke-profile-initial-removed.txt
bash smoke-remote.sh
