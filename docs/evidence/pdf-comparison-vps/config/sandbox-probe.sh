#!/bin/bash
set -euo pipefail
id
cat /etc/os-release
node --version
npm --version
./node_modules/.bin/playwright --version
node --input-type=module -e 'import { readFileSync } from "node:fs"; for (const name of ["@react-pdf/renderer", "pdfmake", "playwright"]) console.log(name, JSON.parse(readFileSync("node_modules/" + name + "/package.json")).version)'
fc-match Arial
dpkg-query -W fonts-liberation procps
printf 'process confinement\n'
cat /proc/self/attr/current
sed -nE '/^(CapEff|NoNewPrivs|Seccomp|Seccomp_filters):/p' /proc/self/status
printf 'cgroup limits\n'
for name in cpu.max cpu.weight cpuset.cpus.effective memory.max memory.swap.max pids.max; do
	printf '%s=' "$name"
	cat "/sys/fs/cgroup/$name"
done
df -h /tmp /dev/shm /bench-out
printf 'network interfaces and routes\n'
cat /proc/net/dev /proc/net/route
printf 'sandbox verification\n'
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { launchReportChromium } from './prototype/pdf/dist/html-chromium.js';

const browser = await launchReportChromium();
try {
	assert.equal(browser.version(), '158.0.8127.18');
	console.log(`Chromium ${browser.version()}`);
	const page = await browser.newPage({ offline: true, javaScriptEnabled: false, serviceWorkers: 'block' });
	await page.setContent('<p>Timekeeper sandbox probe</p>');
	assert.ok((await page.pdf()).length > 0);
	const outerFilters = Number(readFileSync('/proc/self/status', 'utf8').match(/^Seccomp_filters:\s+(\d+)$/m)?.[1]);
	assert.ok(outerFilters >= 1, 'Docker seccomp filter absent');
	let browserFound = false;
	const rendererFilters = [];
	for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
		let cmdline;
		let status;
		try {
			cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
			if (!/(?:^|\/)chrome-headless-shell(?:\s|$)/.test(cmdline[0])) continue;
			status = readFileSync(`/proc/${pid}/status`, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
			throw error;
		}
		const args = cmdline.join(' ').trim();
		assert.ok(!/(?:^|\s)--(?:no-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|single-process)(?:\s|$)/.test(args));
		if (!/(?:^|\s)--type=/.test(args)) {
			browserFound = true;
			console.log(`Browser arguments ${JSON.stringify(cmdline.filter(Boolean))}`);
		}
		if (!/(?:^|\s)--type=renderer(?:\s|$)/.test(args)) continue;
		const filters = Number(status.match(/^Seccomp_filters:\s+(\d+)$/m)?.[1]);
		const namespacePids = status.match(/^NSpid:\s+([\d\t ]+)$/m)?.[1]?.trim().split(/\s+/) ?? [];
		assert.ok(namespacePids.length > 1, 'Chromium renderer PID namespace absent');
		rendererFilters.push(filters);
		console.log(`Chromium renderer ${pid}\n${status.match(/^(NSpid|Seccomp|Seccomp_filters):.*$/gm).join('\n')}`);
	}
	assert.ok(browserFound, 'Chromium browser command line was not found');
	assert.ok(rendererFilters.length > 0 && rendererFilters.every((filters) => filters > outerFilters),
		'Chromium renderer must have an extra seccomp filter');
	console.log(`PASS Docker process filters=${outerFilters}, Chromium renderer filters=${rendererFilters.join(',')}`);
} finally {
	await browser.close();
}
JS
