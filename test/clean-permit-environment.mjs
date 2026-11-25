// Node's test runner isolates each test file in a process. Clear inherited settings before imports and subprocesses.
for (const name of Object.keys(process.env)) {
  if (/^(CLAUDE_PERMIT|ANTHROPIC_PERMIT|CLAUDE_LANE_|PI_)/.test(name)) delete process.env[name];
}
