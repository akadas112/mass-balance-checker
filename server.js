import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function safeTrim(value, maxLength = 5000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function fallbackReport(message) {
  return {
    verdict: "Unable to complete AI review",
    score: 0,
    confidence: "Low",
    auditChecks: [
      {
        title: "AI API connection",
        status: "Failed",
        comment: message
      }
    ],
    strengths: [],
    errors: ["The AI model could not generate a review."],
    corrections: ["Check the API key, model name, and deployment logs, then try again."],
    correctedBalance: "No corrected balance could be generated.",
    biochemicalReasoning: "No biochemical reasoning could be generated because the AI call failed.",
    assumptionsAndLimits: [
      "The checker requires a working LLM API connection.",
      "The user must provide a clear scenario and mass balance attempt."
    ],
    nextSteps: [
      "Verify that OPENAI_API_KEY is set in Render Environment Variables.",
      "Redeploy the Render service.",
      "Try the review again."
    ]
  };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

app.post("/api/review", async (req, res) => {
  try {
    const scenario = safeTrim(req.body.scenario);
    const attempt = safeTrim(req.body.attempt);

    if (!scenario || !attempt) {
      return res.status(400).json({
        error: "Both fermentation scenario and mass balance attempt are required."
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        report: fallbackReport("OPENAI_API_KEY is missing on the server.")
      });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const instructions = `
You are an expert bioprocess calculation examiner and mass balance auditor.

Your job:
- Review a fermentation or bioprocess mass balance attempt.
- Check basis, units, system boundary, input streams, output streams, total mass balance, component balance, gas terms, stoichiometry, yield, conversion, limiting reactants, assumptions, and missing data.
- Identify errors clearly.
- Explain biochemical reasoning in student-friendly language.
- Do not invent missing numerical data. If data are missing, mark the answer as incomplete.
- If a calculation is correct, still mention assumptions and limitations.
- If the student's final conclusion is unsupported, say so.

Return ONLY valid JSON with this exact structure:
{
  "verdict": "Correct | Partially correct | Incomplete | Incorrect",
  "score": 0,
  "confidence": "High | Medium | Low",
  "auditChecks": [
    {"title": "Basis and units", "status": "Pass | Warning | Fail", "comment": "..."}
  ],
  "strengths": ["..."],
  "errors": ["..."],
  "corrections": ["..."],
  "correctedBalance": "...",
  "biochemicalReasoning": "...",
  "assumptionsAndLimits": ["..."],
  "nextSteps": ["..."]
}

Rules:
- score must be a number from 0 to 100.
- correctedBalance can be qualitative if exact numerical correction is impossible.
- Keep the answer detailed enough for an assignment screenshot.
- Avoid unsafe certainty when data are missing.
`;

    const input = `
FERMENTATION / BIOPROCESS SCENARIO:
${scenario}

STUDENT MASS BALANCE ATTEMPT:
${attempt}
`;

    const response = await client.responses.create({
      model: MODEL,
      instructions,
      input
    });

    const text = response.output_text || "";
    const parsed = tryParseJson(text);

    if (!parsed) {
      return res.json({
        report: {
          verdict: "AI review generated",
          score: 50,
          confidence: "Medium",
          auditChecks: [
            {
              title: "AI output",
              status: "Warning",
              comment: "The model returned text that was not valid JSON, so it is shown as a raw review."
            }
          ],
          strengths: [],
          errors: [],
          corrections: [],
          correctedBalance: "See raw AI review below.",
          biochemicalReasoning: text,
          assumptionsAndLimits: ["The output format was not fully structured."],
          nextSteps: ["Try again or simplify the input."]
        },
        model: MODEL
      });
    }

    return res.json({ report: parsed, model: MODEL });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      report: fallbackReport(error.message || "Unknown server error")
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI Mass Balance Checker running on port ${PORT}`);
});
