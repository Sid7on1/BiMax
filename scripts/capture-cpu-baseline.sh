#!/usr/bin/env bash
# WP-6 capture recipe (docs/product-reset/57, §2.0 of record 56).
#
# No Bimax path has a CPU or GPU baseline, and record 57 forbids writing a perf constant in
# WP-1..WP-5 until one exists. This script is that baseline's repeatable half.
#
# It is split by PRIVILEGE, deliberately:
#
#   Tier 1 (no root, runs here)   — per-process CPU%, CPU-seconds and peak RSS for every Bimax
#                                   process, sampled over a real workload. Answers "how much CPU
#                                   does Bimax actually use, and which process spends it".
#   Tier 2 (needs root / Xcode)   — the P-core vs E-core split, package watts and the per-frame
#                                   compositor cost. Printed as exact commands, never run silently,
#                                   because `powermetrics` requires the superuser and Instruments
#                                   requires the GUI. WP-7 (worker QoS) is gated on Tier 2: if
#                                   background work already lands on E-cores there is nothing to win.
#
# PRIVACY (record 57, WP-6): an Instruments trace captures prompt text. Traces go to the scratchpad
# or /tmp, never into the repository. This script writes only process names and numbers.
#
# Usage:
#   scripts/capture-cpu-baseline.sh [seconds] [outfile]
set -uo pipefail

DURATION="${1:-60}"
OUT="${2:-/tmp/bimax-cpu-baseline-$(date +%Y%m%dT%H%M%S).txt}"
INTERVAL=2

# bash 3.2 is what ships on macOS: no associative arrays, no `mapfile`, and an empty array under
# `set -u` is an unbound variable (bimax-release-pipeline).
set +u

{
  echo "# Bimax CPU baseline — tier 1 (no root)"
  echo "date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "machine:   $(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  echo "cores:     $(sysctl -n hw.ncpu) total = $(sysctl -n hw.perflevel0.logicalcpu 2>/dev/null) performance + $(sysctl -n hw.perflevel1.logicalcpu 2>/dev/null) efficiency"
  echo "memory:    $(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 )) GB"
  echo "macOS:     $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "duration:  ${DURATION}s at ${INTERVAL}s intervals"
  echo "load at start: $(sysctl -n vm.loadavg)"
  echo
  echo "## Per-sample CPU% by process"
  echo "# %CPU is of ONE core, as ps reports it: 800% would be all eight saturated."
  printf '%-10s %-8s %-9s %-10s %s\n' "elapsed" "pid" "%cpu" "rss_mb" "process"
} > "$OUT"

# A Bimax process is the Electron app, its helpers, or an engine utilityProcess. Matched on the
# command line rather than a pid list so processes that start mid-capture are picked up too.
PATTERN='[B]imax|[b]imax-engine|[B]imax Helper'

START=$(date +%s)
END=$(( START + DURATION ))
SAMPLES=0
while [ "$(date +%s)" -lt "$END" ]; do
  ELAPSED=$(( $(date +%s) - START ))
  # `ps` gives a decaying average over the process's life, not an instant. Good enough for "which
  # process spends the CPU"; it is NOT good enough for a threshold constant, which is why the P/E
  # split in tier 2 is what WP-7 is actually gated on.
  ps -Ao pid,pcpu,rss,comm | grep -E "$PATTERN" | while read -r PID PCPU RSS COMM; do
    printf '%-10s %-8s %-9s %-10s %s\n' "${ELAPSED}s" "$PID" "$PCPU" "$(( RSS / 1024 ))" "$COMM"
  done >> "$OUT"
  SAMPLES=$(( SAMPLES + 1 ))
  sleep "$INTERVAL"
done

{
  echo
  echo "samples:  $SAMPLES"
  echo "load at end: $(sysctl -n vm.loadavg)"
  echo
  echo "## Totals by process (mean %CPU of one core, peak RSS MB)"
  awk 'NR>1 && $3 ~ /^[0-9.]+$/ {
         sum[$5] += $3; n[$5]++;
         if ($4+0 > peak[$5]) peak[$5] = $4+0
       }
       END { for (p in sum) printf "%-32s mean %7.2f%%  peak %6d MB  (%d samples)\n", p, sum[p]/n[p], peak[p], n[p] }' "$OUT" \
    | sort -t% -k2 -rn
  echo
  echo "## Tier 2 — NOT captured here. Both need privileges this script does not take."
  echo
  echo "# P vs E core split + package watts. WP-7 (sub-agent worker QoS) is gated on this:"
  echo "# if background work already lands on efficiency cores, WP-7 is not worth building."
  echo "sudo powermetrics --samplers cpu_power,gpu_power -i 1000 -n ${DURATION} \\"
  echo "  | tee /tmp/bimax-powermetrics.txt"
  echo
  echo "# Where the cores go, per thread, with the P/E attribution:"
  echo "#   Instruments → CPU Counters, record the app under a real task (index a repo,"
  echo "#   run a multi-step agent turn). Save the trace to /tmp, NEVER into the repo:"
  echo "#   a trace captures prompt text (record 57, WP-6, PRIVACY)."
  echo
  echo "# Compositor cost per frame with the glass on. Decides WP-5's open question —"
  echo "# whether native NSGlassEffectView beats the 23 CSS backdrop-filters:"
  echo "#   Instruments → Metal System Trace, same workload."
  echo
  echo "# Record the numbers as a measurement appendix to docs/product-reset/56."
} >> "$OUT"

echo "Wrote $OUT"
echo
tail -n 40 "$OUT"
