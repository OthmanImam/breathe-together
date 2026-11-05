/**
 * Headless simulation CLI.
 *
 * Runs a full coach session at accelerated simulated time (no real waiting)
 * over one of the mock scenarios and prints a readable timeline:
 * time, coach state, observed user rate, pacer rate, notices.
 *
 * Usage:
 *   npm run simulate -- --scenario agitated_then_settling --minutes 3 --seed 42
 */

/* eslint-disable no-console -- this is the CLI's whole point */

import { FROZEN_DEFAULT_SETTINGS } from "../config.js";
import { MOCK_SCENARIOS, type MockScenario, mulberry32 } from "../signal/mockSource.js";
import { NOTICES } from "../coach/stateMachine.js";
import { buildSummaryLines, type SummaryData } from "../coach/summary.js";
import { createHarness, statesInOrder, type TimelineRow } from "./harness.js";

interface CliArgs {
  scenario?: string;
  minutes: 3 | 5 | 10;
  seed: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const minutesRaw = get("--minutes");
  return {
    scenario: get("--scenario"),
    minutes: parseMinutes(minutesRaw),
    seed: Number(get("--seed") ?? 42),
  };
}

function parseMinutes(v: string | undefined): 3 | 5 | 10 {
  const n = Number(v ?? FROZEN_DEFAULT_SETTINGS.session.defaultMinutes);
  if (!FROZEN_DEFAULT_SETTINGS || (n !== 3 && n !== 5 && n !== 10)) {
    return 3;
  }
  return n;
}

function fmtTime(t: number): string {
  const s = Math.round(t / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function printRow(row: TimelineRow): void {
  const user = row.userRate !== undefined ? row.userRate.toFixed(1) : " --  ";
  const line = `${fmtTime(row.t)}  ${row.state.padEnd(10)} user ${user} bpm | pacer ${row.pacerRate.toFixed(2)} bpm ${row.phase.padEnd(6)} #${row.pacerCycles}`;
  console.log(line);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scenario = args.scenario;
  if (!scenario || !MOCK_SCENARIOS.includes(scenario as MockScenario)) {
    console.error(`Unknown scenario: ${scenario}`);
    console.error(`Usage: npm run simulate -- --scenario <name> [--minutes 3|5|10] [--seed n]`);
    console.error(`Scenarios: ${MOCK_SCENARIOS.join(", ")}`);
    process.exit(1);
  }

  console.log(`# breathe-together headless simulation`);
  console.log(
    `# scenario=${scenario} minutes=${args.minutes} seed=${args.seed} (accelerated time)`,
  );
  console.log("");

  const harness = createHarness({
    scenario: scenario as MockScenario,
    seed: args.seed,
    minutes: args.minutes,
  });
  harness.runMinutes(args.minutes);

  // Print the timeline rows, interleaving notices at their timestamps.
  const noticeByTime = new Map<number, string[]>();
  for (const e of harness.events) {
    if (e.type === "notice") {
      const list = noticeByTime.get(e.t) ?? [];
      list.push(e.message);
      noticeByTime.set(e.t, list);
    }
  }
  let lastState = "";
  for (const row of harness.rows) {
    // Compact: show every sample row; mark state changes and notices.
    const flag =
      row.state !== lastState ? (lastState === "" ? " (start)" : ` (was ${lastState})`) : "";
    lastState = row.state;
    printRow(row);
    if (flag) console.log(`    >>> state: ${row.state}${flag}`);
    const notices = noticeByTime.get(row.t);
    if (notices) for (const n of notices) console.log(`    >>> notice: ${n}`);
  }

  console.log("");
  console.log(`# states visited: ${statesInOrder(harness).join(" -> ")}`);
  const ended = harness.ended;
  if (ended) {
    const summary = ended.summary as SummaryData;
    for (const line of buildSummaryLines(summary)) console.log(`  ${line}`);
  } else {
    console.log("(session did not end within the run)");
  }

  // Determinism spot check: identical seeds must replay identically.
  const replay = createHarness({
    scenario: scenario as MockScenario,
    seed: args.seed,
    minutes: args.minutes,
  });
  replay.runMinutes(args.minutes);
  if (JSON.stringify(replay.rows) !== JSON.stringify(harness.rows)) {
    console.error("# WARNING: replay with the same seed diverged (unexpected)");
    process.exit(2);
  }
  void mulberry32; // exposed for exploratory scripts; unused here
  void NOTICES;
}

main();
