import { readFile } from 'node:fs/promises';

const file = process.argv[2] || 'data/gene-predictions.json';
const data = JSON.parse(await readFile(file, 'utf8'));
const expectedGenes = ['FRO6', 'CBF3', 'RD29A', 'TOC1'];
const expectedEnvironments = ['water', 'drought', 'rewater', 'cold'];
const expectedHorizons = [6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72];
const scenarios = data?.scenarios || {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertBilingual(value, label) {
  assert(typeof value?.zh === 'string' && value.zh.trim(), `${label}: missing Chinese text.`);
  assert(typeof value?.en === 'string' && value.en.trim(), `${label}: missing English text.`);
}

assert(data?.meta?.schemaVersion === 1, 'Unsupported schema version.');
assert(data?.meta?.requestedModel === 'openai/gpt-5.6-sol', 'Gene-state data was not requested from 5.6 Sol.');
assert(typeof data?.meta?.model === 'string' && data.meta.model.includes('gpt-5.6-sol'), 'Returned model is not 5.6 Sol.');
assert(data?.meta?.complete === true, 'Gene-state library is incomplete.');
assert(data?.meta?.scenarioCount === 16, 'Expected 16 gene × environment trajectories.');
assert(data?.meta?.stateCount === 192, 'Expected 192 conditional states.');
assert(JSON.stringify(data?.meta?.horizons) === JSON.stringify(expectedHorizons), 'Unexpected horizon list.');

for (const gene of expectedGenes) {
  for (const environment of expectedEnvironments) {
    const key = `${gene}:${environment}`;
    const scenario = scenarios[key];
    assert(scenario, `Missing scenario ${key}.`);
    assert(scenario.gene?.id === gene, `${key}: incorrect gene metadata.`);
    assert(scenario.environment?.id === environment, `${key}: incorrect environment metadata.`);
    assertBilingual(scenario.title, `${key} title`);
    assertBilingual(scenario.geneFunction, `${key} geneFunction`);
    assert(Array.isArray(scenario.rollouts) && scenario.rollouts.length === expectedHorizons.length, `${key}: expected 12 rollouts.`);
    scenario.rollouts.forEach((rollout, index) => {
      assert(rollout.hours === expectedHorizons[index], `${key}: horizon ${index + 1} is out of order.`);
      assertBilingual(rollout.state, `${key} ${rollout.hours}h state`);
      assertBilingual(rollout.cell, `${key} ${rollout.hours}h cell`);
      assertBilingual(rollout.tissue, `${key} ${rollout.hours}h tissue`);
      assertBilingual(rollout.trait, `${key} ${rollout.hours}h trait`);
      assert(['baseline', 'emerging', 'distinct', 'recovering', 'adapted', 'uncertain'].includes(rollout.divergence), `${key}: invalid divergence.`);
      assert(Number.isInteger(rollout.uncertainty?.confidence), `${key}: missing confidence.`);
      assert(rollout.uncertainty.confidence >= 30 && rollout.uncertainty.confidence <= 85, `${key}: confidence out of range.`);
      assertBilingual(rollout.uncertainty.text, `${key} ${rollout.hours}h uncertainty`);
    });
    assert(Array.isArray(scenario.validation?.readouts) && scenario.validation.readouts.length >= 3, `${key}: missing validation readouts.`);
    assert(Array.isArray(scenario.validation?.controls) && scenario.validation.controls.length >= 2, `${key}: missing validation controls.`);
    scenario.validation.readouts.forEach((value, index) => assertBilingual(value, `${key} readout ${index + 1}`));
    scenario.validation.controls.forEach((value, index) => assertBilingual(value, `${key} control ${index + 1}`));
  }
}

assert(Object.keys(scenarios).length === 16, 'Unexpected extra scenarios.');
console.log(`Validated ${data.meta.stateCount} gene states from ${data.meta.model}.`);
