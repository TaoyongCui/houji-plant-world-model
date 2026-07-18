# Hòujì GitHub-only prediction refresh

The public site stays entirely on GitHub Pages. GitHub Actions calls OpenRouter privately, writes the complete trajectory library to `data/predictions.json`, and commits that public, key-free data back to the repository.

## One-time setup

1. Delete any OpenRouter key that has appeared in chat or another exposed location.
2. Create a new OpenRouter key with a low spending limit.
3. Open the GitHub repository and go to **Settings → Secrets and variables → Actions**.
4. Create a repository secret named `OPENROUTER_API_KEY` and paste the new key there.
5. In **Settings → Actions → General**, ensure workflows are allowed to write repository contents if repository policy blocks the explicit workflow permission.

## Refresh the prediction library

1. Open **Actions → Refresh GPT world trajectories**.
2. Choose **Run workflow**.
3. Keep `openai/gpt-5.6-terra` for the latest balanced GPT-5.6 model, or select `openai/gpt-5.6-sol` for the flagship model at higher cost.
4. The workflow generates 36 species × organ × action trajectories, validates them, uploads a snapshot artifact, and commits `data/predictions.json`.
5. GitHub Pages publishes the refreshed data automatically after the commit reaches `main`.

Each trajectory contains bilingual outputs for every 6-hour horizon from 6 to 72 hours. The browser never receives `OPENROUTER_API_KEY`.

## Local generation

Copy `.env.example` values into your shell without creating a tracked `.env`, then run:

```bash
node scripts/generate-predictions.mjs
node scripts/validate-predictions.mjs data/predictions.json
```

Never commit an API key or place it in `index.html`, workflow YAML, or `data/predictions.json`.
