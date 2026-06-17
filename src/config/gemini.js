const axios = require('axios');

const MAX_RETRIES = 4;
const RETRY_DELAYS = [2000, 4000, 8000, 16000];
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function askGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(url, {
        contents: [
          {
            parts: [{text: prompt}],
          },
        ],
      });

      const text = response.data.candidates[0].content.parts[0].text;
      return text;
    } catch (error) {
      const status = error?.response?.status;
      const isLastAttempt = attempt === MAX_RETRIES - 1;
      const shouldRetry = RETRYABLE_STATUS_CODES.has(status) && !isLastAttempt;

      if (!shouldRetry) {
        throw error;
      }

      console.log(
        `[GEMINI_RETRY] attempt ${attempt + 1} failed (${status}), retrying in ${RETRY_DELAYS[attempt]}ms`,
      );
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
}

module.exports = {askGemini};
