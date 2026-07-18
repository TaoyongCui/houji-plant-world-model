# Hòujì AI prediction deployment

The public GitHub Pages site is static. The AI prediction endpoint must run as a serverless function so the OpenRouter API key stays private.

## Deploy on Vercel

1. Import `TaoyongCui/houji-plant-world-model` in Vercel.
2. Keep the framework preset as `Other` and the project root as the repository root.
3. Add these environment variables in Vercel:
   - `OPENROUTER_API_KEY`: a newly generated OpenRouter key with a low credit limit.
   - `OPENROUTER_MODEL`: `openai/gpt-4o-mini` (verified), or another structured-output model.
   - `ALLOWED_ORIGINS`: the deployed site origin, plus `https://taoyongcui.github.io` if the GitHub Pages frontend will call this API.
   - `SAFETY_SALT`: a long random string.
   - `SITE_URL`: the public site URL used to identify the app to OpenRouter.
4. Deploy. When the whole site runs on Vercel, the frontend automatically uses `/api/predict`.
5. To keep GitHub Pages as the frontend, set the `houji-api` meta tag in `index.html` to the full Vercel function URL, for example `https://YOUR-PROJECT.vercel.app/api/predict`.

The API includes input limits, an origin allowlist, a short timeout and a lightweight rate limit. Also set a hard credit limit on the OpenRouter key because public endpoints can still be abused.

Never commit `.env` or put `OPENROUTER_API_KEY` in `index.html`. If a key has appeared in chat or any public place, delete it and create a replacement before deployment.
