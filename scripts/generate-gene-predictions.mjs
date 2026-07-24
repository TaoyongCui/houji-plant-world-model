import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.GENE_PREDICTION_MODEL || 'openai/gpt-5.6-sol';
const OUTPUT_PATH = process.env.GENE_PREDICTIONS_OUTPUT || 'data/gene-predictions.json';
const CHECKPOINT_PATH = process.env.GENE_PREDICTIONS_CHECKPOINT || '.gene-prediction-checkpoint.json';
const CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.GENERATION_CONCURRENCY) || 2));
const SCENARIO_LIMIT = Math.max(0, Number(process.env.SCENARIO_LIMIT) || 0);
const HORIZONS = [6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72];

const GENES = [
  {
    id: 'FRO6',
    name: 'Ferric Reduction Oxidase 6',
    context: 'leaf and mesophyll iron reduction, chloroplast redox balance, and stress-dependent photosynthetic function',
  },
  {
    id: 'CBF3',
    name: 'C-repeat Binding Factor 3 / DREB1A',
    context: 'cold-response transcriptional control, acclimation programs, and growth-defense tradeoffs',
  },
  {
    id: 'RD29A',
    name: 'Responsive to Desiccation 29A',
    context: 'dehydration-responsive transcription and a readout of ABA-dependent and ABA-independent stress programs',
  },
  {
    id: 'TOC1',
    name: 'Timing of CAB Expression 1',
    context: 'circadian oscillator state, phase-dependent environmental response, and clock-growth coordination',
  },
];

const ENVIRONMENTS = [
  {
    id: 'water',
    zh: '正常供水',
    en: 'Well-watered',
    protocol: 'well-watered control conditions across the full 72-hour horizon',
  },
  {
    id: 'drought',
    zh: '持续干旱',
    en: 'Sustained drought',
    protocol: 'progressive moderate drought from hour 0 through hour 72',
  },
  {
    id: 'rewater',
    zh: '24 小时复水',
    en: 'Rewater at 24 hours',
    protocol: 'progressive moderate drought from hour 0 to hour 24, followed by full rewatering at hour 24; pre-24-hour states belong to the drought phase',
  },
  {
    id: 'cold',
    zh: '冷胁迫',
    en: 'Cold stress',
    protocol: 'stable non-freezing cold stress with a normal photoperiod across the full 72-hour horizon',
  },
];

const bilingualText = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zh: { type: 'string', minLength: 2, maxLength: 80 },
    en: { type: 'string', minLength: 3, maxLength: 180 },
  },
  required: ['zh', 'en'],
};

const GENE_PREDICTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: bilingualText,
    geneFunction: bilingualText,
    rollouts: {
      type: 'array',
      minItems: HORIZONS.length,
      maxItems: HORIZONS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: bilingualText,
          cell: bilingualText,
          tissue: bilingualText,
          trait: bilingualText,
          divergence: {
            type: 'string',
            enum: ['baseline', 'emerging', 'distinct', 'recovering', 'adapted', 'uncertain'],
          },
          uncertainty: {
            type: 'object',
            additionalProperties: false,
            properties: {
              level: { type: 'string', enum: ['low', 'medium', 'high'] },
              confidence: { type: 'integer', minimum: 30, maximum: 85 },
              text: bilingualText,
            },
            required: ['level', 'confidence', 'text'],
          },
        },
        required: ['state', 'cell', 'tissue', 'trait', 'divergence', 'uncertainty'],
      },
    },
    validation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        readouts: {
          type: 'array',
          minItems: 3,
          maxItems: 4,
          items: bilingualText,
        },
        controls: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: bilingualText,
        },
      },
      required: ['readouts', 'controls'],
    },
  },
  required: ['title', 'geneFunction', 'rollouts', 'validation'],
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const scenarioKey = (gene, environment) => `${gene.id}:${environment.id}`;

async function readCheckpoint() {
  try {
    const checkpoint = JSON.parse(await readFile(CHECKPOINT_PATH, 'utf8'));
    if (checkpoint.requestedModel !== MODEL) return newCheckpoint();
    return checkpoint;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return newCheckpoint();
  }
}

function newCheckpoint() {
  return {
    requestedModel: MODEL,
    returnedModel: MODEL,
    scenarios: {},
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function saveCheckpoint(checkpoint) {
  const temporaryPath = `${CHECKPOINT_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, CHECKPOINT_PATH);
}

function extractPrediction(body) {
  const content = body?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map(part => part?.text || '').join('')
    : content;
  if (!text) throw new Error('Model returned empty content.');
  return JSON.parse(text);
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
    species: 'Arabidopsis thaliana',
    organ: 'vegetative leaf',
    gene: {
      symbol: job.gene.id,
      name: job.gene.name,
      biologicalContext: job.gene.context,
    },
    environment: {
      id: job.environment.id,
      label: `${job.environment.en} / ${job.environment.zh}`,
      protocol: job.environment.protocol,
    },
    baseline: 'same genotype and starting leaf-cell state, vegetative stage, standard photoperiod, adequate nutrition, otherwise favorable conditions',
    forecastHours: HORIZONS,
  };

  const instructions = [
    'You generate a precomputed gene-associated conditional state trajectory for the Hòujì plant world-model dashboard.',
    'Treat the selected gene as a molecular probe of state, not automatically as a genetic intervention and not as proof of gene causality.',
    'Produce a concise, mechanistically plausible hypothesis for Arabidopsis leaf biology, not a claim of experimental proof and not a literature review.',
    'Never invent citations, accession numbers, p-values, exact fold changes, exact measured effect sizes, or completed experiments.',
    `Return exactly twelve rollout objects in this order: ${HORIZONS.map(hour => `${hour} h`).join(', ')}. Numeric hour labels are added after validation.`,
    'Make the twelve horizons a coherent trajectory. Rapid signaling and transcription can precede tissue and visible trait changes.',
    'For rewatering, respect the full action history: drought precedes hour 24, rewatering occurs at hour 24, and recovery is not simple time reversal.',
    'For TOC1, acknowledge circadian phase dependence without inventing a phase when the initial Zeitgeber time is unspecified.',
    'For FRO6, keep claims strongest for leaf or mesophyll redox and photosynthetic contexts.',
    'State is the gene-associated cell-state interpretation at the selected horizon. Cell, tissue and trait must describe distinct biological scales.',
    'Confidence reflects context adequacy and mechanistic support, not statistical probability.',
    'Chinese and English fields must be concise, natural, scientifically cautious, and semantically equivalent.',
    'Keep every Chinese field under 48 Chinese characters and every English field under 22 words. Use one sentence per field.',
    'Use uncertainty text to name the single most important missing condition or ambiguity.',
    'Recommend measurable readouts and matched controls that could test the trajectory.',
  ].join(' ');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8 * 60 * 1000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://taoyongcui.github.io/houji-plant-world-model/',
        'X-Title': 'HOUJI Gene-State Batch Generator',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: `Scenario data: ${JSON.stringify(scenario)}` },
        ],
        reasoning: { effort: 'medium', exclude: true },
        max_completion_tokens: 10000,
        seed: 20260724,
        provider: { require_parameters: true },
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'gene_state_trajectory',
            strict: true,
            schema: GENE_PREDICTION_SCHEMA,
          },
        },
      }),
    });
  } catch (error) {
    clearTimeout(timeout);
    if (attempt < 4) {
      console.warn(`${scenarioKey(job.gene, job.environment)}: request error; retry ${attempt + 1}/4.`);
      await sleep(1800 * (2 ** (attempt - 1)));
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
        : 1800 * (2 ** (attempt - 1));
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
      console.warn(`${scenarioKey(job.gene, job.environment)}: ${error.message}; retry ${attempt + 1}/4.`);
      await sleep(1800 * (2 ** (attempt - 1)));
      return requestPrediction(job, attempt + 1);
    }
    throw error;
  }

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
  if (MODEL !== 'openai/gpt-5.6-sol') {
    throw new Error('The gene-state library must be generated with openai/gpt-5.6-sol.');
  }

  const allJobs = GENES.flatMap(gene =>
    ENVIRONMENTS.map(environment => ({ gene, environment })),
  );
  const targetJobs = SCENARIO_LIMIT > 0 ? allJobs.slice(0, SCENARIO_LIMIT) : allJobs;
  const checkpoint = await readCheckpoint();
  const jobs = targetJobs.filter(job => !checkpoint.scenarios[scenarioKey(job.gene, job.environment)]);
  const usage = checkpoint.usage;

  console.log(`Generating ${jobs.length} remaining gene-state trajectories with ${MODEL} at concurrency ${CONCURRENCY}.`);
  if (jobs.length !== targetJobs.length) {
    console.log(`Resuming from ${targetJobs.length - jobs.length} checkpointed trajectories.`);
  }

  await mapWithConcurrency(jobs, CONCURRENCY, async (job, index) => {
    const key = scenarioKey(job.gene, job.environment);
    console.log(`[${index + 1}/${jobs.length}] ${key}`);
    const result = await requestPrediction(job);
    usage.promptTokens += Number(result.usage.prompt_tokens || 0);
    usage.completionTokens += Number(result.usage.completion_tokens || 0);
    usage.totalTokens += Number(result.usage.total_tokens || 0);
    checkpoint.returnedModel = result.returnedModel;
    checkpoint.scenarios[key] = {
      gene: {
        id: job.gene.id,
        name: job.gene.name,
      },
      environment: {
        id: job.environment.id,
        zh: job.environment.zh,
        en: job.environment.en,
      },
      ...result.prediction,
    };
    await saveCheckpoint(checkpoint);
  });

  const scenarioEntries = targetJobs.map(job => {
    const key = scenarioKey(job.gene, job.environment);
    return [key, checkpoint.scenarios[key]];
  });
  if (scenarioEntries.some(([, value]) => !value)) {
    throw new Error('Checkpoint is missing one or more target scenarios.');
  }

  const output = {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      model: checkpoint.returnedModel,
      requestedModel: MODEL,
      modelLabel: '5.6 Sol',
      provider: 'OpenRouter',
      generator: 'Hòujì gene-state batch generator',
      scenarioCount: scenarioEntries.length,
      geneCount: new Set(targetJobs.map(job => job.gene.id)).size,
      environmentCount: new Set(targetJobs.map(job => job.environment.id)).size,
      complete: scenarioEntries.length === allJobs.length,
      horizons: HORIZONS,
      stateCount: scenarioEntries.length * HORIZONS.length,
      usage,
    },
    scenarios: Object.fromEntries(scenarioEntries),
  };

  const destination = path.resolve(OUTPUT_PATH);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  if (output.meta.complete) {
    await unlink(CHECKPOINT_PATH).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  console.log(`Wrote ${output.meta.stateCount} states across ${scenarioEntries.length} trajectories to ${destination}.`);
  console.log(`Token usage: ${usage.totalTokens} total (${usage.promptTokens} input, ${usage.completionTokens} output).`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
