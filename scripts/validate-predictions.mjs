import { readFile } from 'node:fs/promises';
import process from 'node:process';

const file = process.argv[2] || 'data/predictions.json';
const expectedHorizons = [6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const data = JSON.parse(await readFile(file, 'utf8'));
assert(data?.meta?.schemaVersion === 1, 'Unsupported prediction schema version.');
assert(typeof data?.meta?.model === 'string' && data.meta.model.length > 0, 'Missing model metadata.');
assert(data?.scenarios && typeof data.scenarios === 'object', 'Missing scenarios object.');

const scenarios = Object.entries(data.scenarios);
assert(scenarios.length === data.meta.scenarioCount, 'Scenario count does not match metadata.');
if (data.meta.complete) assert(scenarios.length === 36, 'A complete batch must contain 36 scenarios.');

for (const [key, scenario] of scenarios) {
  assert(Array.isArray(scenario.rollouts), `${key}: missing rollouts.`);
  const horizons = scenario.rollouts.map(item => item.hours).sort((a, b) => a - b);
  assert(JSON.stringify(horizons) === JSON.stringify(expectedHorizons), `${key}: invalid rollout horizons.`);
  for (const rollout of scenario.rollouts) {
    for (const scale of ['cell', 'tissue', 'trait']) {
      assert(rollout?.[scale]?.text?.zh && rollout?.[scale]?.text?.en, `${key}@${rollout.hours}: missing ${scale} translation.`);
    }
    assert(Number.isInteger(rollout?.uncertainty?.confidence), `${key}@${rollout.hours}: invalid confidence.`);
  }
}

console.log(`Validated ${scenarios.length} trajectories from ${data.meta.model}.`);
