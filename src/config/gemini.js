const axios = require('axios');

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 4000, 8000];
const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const MODELS = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callModel(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const response = await axios.post(url, {
    contents: [
      {
        parts: [{text: prompt}],
      },
    ],
  });
  return response.data.candidates[0].content.parts[0].text;
}

async function askGemini(prompt) {
  let lastError = null;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const text = await callModel(model, prompt);
        if (model !== MODELS[0]) {
          console.log(`[GEMINI_FALLBACK] succeeded with ${model}`);
        }
        return text;
      } catch (error) {
        lastError = error;
        const status = error?.response?.status;
        const isLastAttempt = attempt === MAX_RETRIES - 1;
        const shouldRetry = RETRYABLE_STATUS_CODES.has(status) && !isLastAttempt;

        if (!shouldRetry) {
          console.log(
            `[GEMINI] ${model} failed (${status || error.message}), trying next model`,
          );
          break;
        }

        console.log(
          `[GEMINI_RETRY] ${model} attempt ${attempt + 1} failed (${status}), retrying in ${RETRY_DELAYS[attempt]}ms`,
        );
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
  }

  throw lastError;
}

module.exports = {askGemini};
