module.exports = function handler(req, res) {
  res.json({
    openrouter: process.env.INFER_KEY_OPENROUTER || '',
    gemini:     process.env.INFER_KEY_GEMINI     || '',
    cerebras:   process.env.INFER_KEY_CEREBRAS   || '',
    groq:       process.env.INFER_KEY_GROQ        || '',
  });
};
