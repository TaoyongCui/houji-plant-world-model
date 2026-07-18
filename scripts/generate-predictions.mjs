import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5.6-terra';
const OUTPUT_PATH = process.env.PREDICTIONS_OUTPUT || 'data/predictions.json';
const CHECKPOINT_PATH = process.env.PREDICTIONS_CHECKPOINT || '.prediction-checkpoint.json';
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.GENERATION_CONCURRENCY) || 2));
const SCENARIO_LIMIT = Math.max(0, Number(process.env.SCENARIO_LIMIT) || 0);
const HORIZONS = [6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72];

const SPECIES = [
  { id: 'arabidopsis', scientific: 'Arabidopsis thaliana', zh: '拟南芥', en: 'Arabidopsis' },
  { id: 'rice', scientific: 'Oryza sativa', zh: '水稻', en: 'Rice' },
  { id: 'maize', scientific: 'Zea mays', zh: '玉米', en: 'Maize' },
];

const ORGANS = [
  { id: 'leaf', zh: '叶片', en: 'Leaf' },
  { id: 'root', zh: '根', en: 'Root' },
  { id: 'seedling', zh: '幼苗', en: 'Seedling' },
];

const ACTIONS = [
  {
    id: 'drought',
    zh: '干旱',
    en: 'Drought',
    protocol: 'progressive, moderate drought stress maintained across the forecast horizon',
  },
  {
    id: 'rewater',
    zh: '复水',
    en: 'Rewatering',
    protocol: 'full rewatering after a moderate drought episode; recovery is not assumed to be simple time reversal',
  },
  {
    id: 'cold',
    zh: '冷胁迫',
    en: 'Cold stress',
    protocol: 'non-freezing cold stress with stable light conditions across the forecast horizon',
  },
  {
    id: 'fro6',
    zh: 'FRO6 上调',
    en: 'FRO6 upregulation',
    protocol: 'FRO6 upregulation under moderate drought; explicitly lower confidence outside leaf or mesophyll contexts',
  },
];

const bilingualText = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zh: { type: 'string' },
    en: { type: 'string' },
  },
  required: ['zh', 'en'],
};

const scalePrediction = {
  type: 'object',
  additionalProperties: false,
  properties: {
    direction: {
      type: 'string',
      enum: ['increase', 'decrease', 'mixed', 'stable', 'uncertain'],
    },
    text: bilingualText,
  },
  required: ['direction', 'text'],
};

const PREDICTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: bilingualText,
    rollouts: {
      type: 'array',
      minItems: HORIZONS.length,
      maxItems: HORIZONS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stage: bilingualText,
          summary: bilingualText,
          cell: scalePrediction,
          tissue: scalePrediction,
          trait: scalePrediction,
          uncertainty: {
            type: 'object',
            additionalProperties: false,
            properties: {
              level: { type: 'string', enum: ['low', 'medium', 'high'] },
              confidence: { type: 'integer', minimum: 20, maximum: 85 },
              text: bilingualText,
            },
            required: ['level', 'confidence', 'text'],
          },
        },
        required: ['stage', 'summary', 'cell', 'tissue', 'trait', 'uncertainty'],
      },
    },
    mechanisms: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: bilingualText,
    },
    assumptions: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: bilingualText,
    },
    validation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        readouts: {
          type: 'array',
          minItems: 3,
          maxItems: 5,
          items: bilingualText,
        },
        design: bilingualText,
      },
      required: ['readouts', 'design'],
    },
  },
  required: ['title', 'rollouts', 'mechanisms', 'assumptions', 'validation'],
};

function scenarioKey(species, organ, action) {
  return `${species.id}.${organ.id}.${action.id}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readCheckpoint() {
  try {
    const checkpoint = JSON.parse(await readFile(CHECKPOINT_PATH, 'utf8'));
    if (checkpoint?.requestedModel === MODEL && checkpoint?.schemaVersion === 1 && checkpoint?.scenarios) {
      return checkpoint;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Ignoring unreadable checkpoint: ${error.message}`);
  }
  return {
    schemaVersion: 1,
    requestedModel: MODEL,
    returnedModel: MODEL,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    scenarios: {},
  };
}

let checkpointWrite = Promise.resolve();
function saveCheckpoint(checkpoint) {
  checkpointWrite = checkpointWrite.then(async () => {
    const destination = path.resolve(CHECKPOINT_PATH);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
  });
  return checkpointWrite;
}

function extractPrediction(response) {
  const message = response?.choices?.[0]?.message;
  if (!message) throw new Error('Model returned no message.');
  if (message.refusal) throw new Error(message.refusal);
  const content = Array.isArray(message.content)
    ? message.content.map(item => item?.text || '').join('')
    : message.content;
  if (!content) throw new Error('Model returned empty content.');
  return JSON.parse(content);
}

function validatePrediction(prediction) {
  if (!prediction?.rollouts || prediction.rollouts.length !== HORIZONS.length) {
    throw new Error(`Expected ${HORIZONS.length} ordered rollout stages.`);
  }
  prediction.rollouts.forEach((rollout, index) => {
    rollout.hours = HORIZONS[index];
  });
  return prediction;
}

async function requestPrediction(job, attempt = 1) {
  const scenario = {
    species: `${job.species.scientific} (${job.species.en}; ${job.species.zh})`,
    organ: `${job.organ.en} (${job.organ.zh})`,
    action: `${job.action.en} (${job.action.zh})`,
    protocol: job.action.protocol,
    baseline: 'vegetative stage, standard photoperiod, moderate treatment intensity, otherwise unstressed and adequately nourished',
    forecastHours: HORIZONS,
  };

  const instructions = [
    'You generate a precomputed plant systems-biology conditional trajectory for the Hòujì world-model research dashboard.',
    'Produce a concise, mechanistically plausible hypothesis, not a claim of experimental proof and not a citation-backed literature review.',
    'Use established high-level plant physiology and species/organ context. Never invent accession numbers, citations, p-values, exact measured effect sizes, or completed experiments.',
    'Directions are relative to an untreated plant of the same age at each timepoint.',
    'If a scale sentence contains biologically important changes in opposing directions, use the mixed direction.',
    `Return exactly twelve rollout objects in this order: ${HORIZONS.map(hour => `${hour} h`).join(', ')}. The generator assigns the numeric labels after validation.`,
    'Make all twelve horizons a coherent temporal progression; avoid repeating the same sentence with minor wording changes.',
    'Separate cell, tissue and whole-organism trait scales. Respect biological timing: signaling can precede transcriptional, tissue and trait changes.',
    'State assumptions and reduce confidence when dose, genotype, developmental stage or organ relevance is underspecified.',
    'For FRO6 outside leaf/mesophyll contexts, explicitly identify limited transferability and use high uncertainty.',
    'Confidence measures adequacy of context and general mechanistic support, not statistical probability.',
    'Chinese and English fields must be concise, natural and semantically equivalent.',
    'Recommend measurable readouts, controls and timepoints that could validate the trajectory.',
  ].join(' ');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://taoyongcui.github.io/houji-plant-world-model/',
        'X-Title': 'HOUJI Plant World Model Batch Generator',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: `Scenario data: ${JSON.stringify(scenario)}` },
        ],
        reasoning: { effort: 'medium', exclude: true },
        max_completion_tokens: 9000,
        seed: 20260718,
        provider: { require_parameters: true },
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'plant_world_trajectory',
            strict: true,
            schema: PREDICTION_SCHEMA,
          },
        },
      }),
    });
  } catch (error) {
    clearTimeout(timeout);
    if (attempt < 4) {
      console.warn(`${scenarioKey(job.species, job.organ, job.action)}: request error; retry ${attempt + 1}/4.`);
      await sleep(1500 * (2 ** (attempt - 1)));
      return requestPrediction(job, attempt + 1);
    }
    throw error;
  }
  clearTimeout(timeout);

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    if (retryable && attempt < 4) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1500 * (2 ** (attempt - 1));
      await sleep(delay);
      return requestPrediction(job, attempt + 1);
    }
    throw new Error(body?.error?.message || `OpenRouter request failed (${response.status}).`);
  }

  let prediction;
  try {
    prediction = validatePrediction(extractPrediction(body));
  } catch (error) {
    if (attempt < 4) {
      console.warn(`${scenarioKey(job.species, job.organ, job.action)}: ${error.message}; retry ${attempt + 1}/4.`);
      await sleep(1500 * (2 ** (attempt - 1)));
      return requestPrediction(job, attempt + 1);
    }
    throw error;
  }
  prediction.validation.timepoints = ['0 h', '6 h', '12 h', '24 h', '48 h', '72 h'];
  return {
    prediction,
    usage: body.usage || {},
    returnedModel: body.model || MODEL,
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let failure = null;

  async function runWorker() {
    while (!failure && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failure = error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  if (failure) throw failure;
  return results;
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required. Store it in GitHub Actions Secrets.');
  }

  const allJobs = SPECIES.flatMap(species =>
    ORGANS.flatMap(organ =>
      ACTIONS.map(action => ({ species, organ, action })),
    ),
  );
  const targetJobs = SCENARIO_LIMIT > 0 ? allJobs.slice(0, SCENARIO_LIMIT) : allJobs;
  const checkpoint = await readCheckpoint();
  const jobs = targetJobs.filter(job => !checkpoint.scenarios[scenarioKey(job.species, job.organ, job.action)]);
  const usage = checkpoint.usage;

  console.log(`Generating ${jobs.length} remaining trajectories with ${MODEL} at concurrency ${CONCURRENCY}.`);
  if (jobs.length !== targetJobs.length) console.log(`Resuming from ${targetJobs.length - jobs.length} checkpointed trajectories.`);
  await mapWithConcurrency(jobs, CONCURRENCY, async (job, index) => {
    const key = scenarioKey(job.species, job.organ, job.action);
    console.log(`[${index + 1}/${jobs.length}] ${key}`);
    const result = await requestPrediction(job);
    usage.promptTokens += Number(result.usage.prompt_tokens || 0);
    usage.completionTokens += Number(result.usage.completion_tokens || 0);
    usage.totalTokens += Number(result.usage.total_tokens || 0);
    checkpoint.returnedModel = result.returnedModel;
    checkpoint.scenarios[key] = {
      species: job.species,
      organ: job.organ,
      action: { id: job.action.id, zh: job.action.zh, en: job.action.en },
      ...result.prediction,
    };
    await saveCheckpoint(checkpoint);
  });

  const scenarioEntries = targetJobs.map(job => {
    const key = scenarioKey(job.species, job.organ, job.action);
    return [key, checkpoint.scenarios[key]];
  });
  if (scenarioEntries.some(([, value]) => !value)) throw new Error('Checkpoint is missing one or more target scenarios.');
  const scenarios = Object.fromEntries(scenarioEntries);
  const output = {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      model: checkpoint.returnedModel,
      requestedModel: MODEL,
      provider: 'OpenRouter',
      generator: 'GitHub Actions',
      scenarioCount: scenarioEntries.length,
      complete: scenarioEntries.length === allJobs.length,
      horizons: HORIZONS,
      baseline: {
        zh: '营养生长期 · 标准光周期 · 中等处理强度 · 其余条件适宜',
        en: 'Vegetative stage · standard photoperiod · moderate treatment · otherwise favorable conditions',
      },
      usage,
    },
    scenarios,
  };

  const destination = path.resolve(OUTPUT_PATH);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  if (output.meta.complete) await unlink(CHECKPOINT_PATH).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log(`Wrote ${scenarioEntries.length} trajectories to ${destination}.`);
  console.log(`Token usage: ${usage.totalTokens} total (${usage.promptTokens} input, ${usage.completionTokens} output).`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
