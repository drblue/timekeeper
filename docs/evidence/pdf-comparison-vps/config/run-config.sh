#!/bin/bash
container_options=(
	--init --network none --cpus 1.5 --cpu-shares 512
	--memory 2g --memory-swap 2g --pids-limit 256 --shm-size 512m
	--cap-drop ALL --security-opt no-new-privileges
	--security-opt "seccomp=$PWD/seccomp_profile.json"
	--read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777
	--user "$(id -u):$(id -g)" --env HOME=/tmp
	--mount "type=bind,src=$PWD/results,dst=/bench-out"
	--label timekeeper-benchmark=01a1c539
)
test_image=timekeeper-pdf-vps:01a1c539
