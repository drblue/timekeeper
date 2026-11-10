#!/bin/bash
set -euo pipefail
cd /var/tmp/timekeeper-pdf-vps-01a1c539
source run-config.sh
name=timekeeper-pdf-vps-benchmark-01a1c539
service_format='{{.Id}} {{.State.Status}} {{.RestartCount}} {{.State.StartedAt}} {{with index .State "Health"}}{{.Status}}{{else}}none{{end}}'
host_snapshot() {
	date -u +%FT%TZ
	hostname
	uname -srm
	cat /etc/os-release
	lscpu | sed -n '1,18p'
	grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
	cat /proc/loadavg
	cat /proc/pressure/{cpu,memory,io}
	df -h /var/tmp
	docker info --format 'Docker {{.ServerVersion}} {{.Architecture}} cgroup={{.CgroupVersion}} driver={{.Driver}}'
	docker ps --no-trunc --format '{{.ID}} {{.Names}} {{.Status}}'
}
host_snapshot > logs/host-before.txt
mapfile -t service_ids < <(docker ps -q --no-trunc)
(( ${#service_ids[@]} > 0 ))
timeout 6s docker inspect --format "$service_format" "${service_ids[@]}" > logs/services-before.txt
grep -q 'PASS Docker process filters=' logs/runtime.txt
available=$(awk '$1=="MemAvailable:" {print $2}' /proc/meminfo)
(( available >= 393216 ))
docker create --name "$name" "${container_options[@]}" "$test_image" /bin/bash -c "$(cat run-workloads.sh)" > logs/benchmark-container-id.txt
docker inspect --format 'image={{.Image}} user={{.Config.User}} privileged={{.HostConfig.Privileged}} network={{.HostConfig.NetworkMode}} publishedPorts={{json .HostConfig.PortBindings}} readonly={{.HostConfig.ReadonlyRootfs}} init={{.HostConfig.Init}} ipc={{.HostConfig.IpcMode}} pidMode={{.HostConfig.PidMode}} capabilitiesAdded={{json .HostConfig.CapAdd}} capabilitiesDropped={{json .HostConfig.CapDrop}} memory={{.HostConfig.Memory}} memorySwap={{.HostConfig.MemorySwap}} nanoCpus={{.HostConfig.NanoCpus}} cpuShares={{.HostConfig.CpuShares}} pidsLimit={{.HostConfig.PidsLimit}} shmSize={{.HostConfig.ShmSize}} tmpfs={{json .HostConfig.Tmpfs}} binds={{json .Mounts}} appArmor={{.AppArmorProfile}}' "$name" > logs/container-config.txt
capture_exit() {
	local status=$?
	trap - EXIT
	if [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]]; then
		timeout --kill-after=4s 20s docker stop --time 12 "$name" >> logs/guard.log 2>&1 || :
	fi
	docker logs --timestamps "$name" > logs/workloads.log 2>&1 || :
	docker inspect --format '{{json .State}}' "$name" > logs/container-exit.json || :
	host_snapshot > logs/host-after.txt || :
	timeout 6s docker inspect --format "$service_format" "${service_ids[@]}" > logs/services-after.txt || :
	(cd results; find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > logs/results.sha256 || :
	exit "$status"
}
trap capture_exit EXIT
trap 'echo "Benchmark supervisor interrupted" >> logs/guard.log; exit 143' TERM INT HUP
docker start "$name" >/dev/null
pid=$(docker inspect --format '{{.State.Pid}}' "$name")
cgroup="/sys/fs/cgroup$(awk -F: '$1==0 {print $3}' "/proc/$pid/cgroup")"
printf '%s\n' "$cgroup" > logs/benchmark-cgroup-path.txt
: > logs/guard.log
printf 'utc\thost_available_kib\thost_load1\thost_cpu_user_ticks\thost_cpu_nice_ticks\thost_cpu_system_ticks\thost_cpu_idle_ticks\thost_cpu_iowait_ticks\thost_cpu_irq_ticks\thost_cpu_softirq_ticks\thost_cpu_steal_ticks\tcontainer_memory_bytes\tcontainer_peak_bytes\tcontainer_cpu_usec\tcontainer_throttled_periods\tcontainer_throttled_usec\tcontainer_pids\tcontainer_oom_kills\n' > logs/host-samples.tsv
deadline=$((SECONDS + 1160))
while [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]]; do
	available=$(awk '$1=="MemAvailable:" {print $2}' /proc/meminfo)
	read -r load1 _ </proc/loadavg
	read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ </proc/stat
	memory=$(cat "$cgroup/memory.current" 2>/dev/null || printf 'NA')
	peak=$(cat "$cgroup/memory.peak" 2>/dev/null || printf 'NA')
	read -r cpu_usec throttled_periods throttled_usec < <(awk '$1=="usage_usec"{u=$2} $1=="nr_throttled"{n=$2} $1=="throttled_usec"{t=$2} END{print u+0, n+0, t+0}' "$cgroup/cpu.stat" 2>/dev/null || :)
	pids=$(cat "$cgroup/pids.current" 2>/dev/null || printf 'NA')
	oom=$(awk '$1=="oom_kill" {print $2}' "$cgroup/memory.events" 2>/dev/null || printf 'NA')
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%T.%3NZ)" "$available" "$load1" "$cpu_user" "$cpu_nice" "$cpu_system" "$cpu_idle" "$cpu_iowait" "$cpu_irq" "$cpu_softirq" "$cpu_steal" "$memory" "$peak" "$cpu_usec" "$throttled_periods" "$throttled_usec" "$pids" "$oom" >> logs/host-samples.tsv
	reason=
	if (( available < 393216 )); then
		reason="host available memory fell below 384 MiB ($available KiB)"
	elif (( SECONDS >= deadline )); then
		reason='benchmark supervisor deadline reached'
	elif ! timeout 6s docker inspect --format "$service_format" "${service_ids[@]}" > logs/services-current.txt ||
		! cmp -s logs/services-before.txt logs/services-current.txt; then
		reason='existing service state changed or Docker health check failed'
	elif [[ "$oom" =~ ^[0-9]+$ ]] && (( oom > 0 )); then
		reason='benchmark cgroup reported an OOM kill'
	fi
	if [[ -n "$reason" ]]; then
		printf '%s STOP %s\n' "$(date -u +%FT%TZ)" "$reason" >> logs/guard.log
		exit 1
	fi
	sleep 2
done
printf '%s Benchmark container exited\n' "$(date -u +%FT%TZ)" >> logs/guard.log
exit "$(docker wait "$name")"
