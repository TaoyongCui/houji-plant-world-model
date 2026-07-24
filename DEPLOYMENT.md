# Hòujì GitHub-only prediction refresh

The public site stays entirely on GitHub Pages. GitHub Actions calls OpenRouter privately and commits public, key-free result libraries back to the repository:

- `data/predictions.json`: species × organ × action world trajectories.
- `data/gene-predictions.json`: gene × environment × duration trajectories for section 03.

## One-time setup

1. Delete any OpenRouter key that has appeared in chat or another exposed location.
2. Create a new OpenRouter key with a low spending limit.
3. Open the GitHub repository and go to **Settings → Secrets and variables → Actions**.
4. Create a repository secret named `OPENROUTER_API_KEY` and paste the new key there.
5. In **Settings → Actions → General**, ensure workflows are allowed to write repository contents if repository policy blocks the explicit workflow permission.

## Refresh the prediction library

1. Open **Actions → Refresh AI world trajectories**.
2. Choose **Run workflow**.
3. Keep `openai/gpt-5.6-terra` for the latest balanced GPT-5.6 model, or select `openai/gpt-5.6-sol` for the flagship model at higher cost.
4. The workflow generates 36 species × organ × action trajectories, validates them, uploads a snapshot artifact, and commits `data/predictions.json`.
5. GitHub Pages publishes the refreshed data automatically after the commit reaches `main`.

Each trajectory contains bilingual outputs for every 6-hour horizon from 6 to 72 hours. The browser never receives `OPENROUTER_API_KEY`.

## Refresh the section 03 gene-state library

1. Open **Actions → Refresh gene-state trajectories**.
2. Choose **Run workflow** and the preferred request concurrency.
3. The workflow always uses `openai/gpt-5.6-sol`.
4. It generates 4 genes × 4 environments × 12 horizons, validates all 192 states, uploads a snapshot artifact, and commits `data/gene-predictions.json`.
5. Section 03 reads the refreshed file automatically after GitHub Pages publishes the commit.

## Local generation

Copy `.env.example` values into your shell without creating a tracked `.env`, then run:

```bash
node scripts/generate-predictions.mjs
node scripts/validate-predictions.mjs data/predictions.json
node scripts/generate-gene-predictions.mjs
node scripts/validate-gene-predictions.mjs data/gene-predictions.json
```

Never commit an API key or place it in `index.html`, workflow YAML, or either prediction data file.
