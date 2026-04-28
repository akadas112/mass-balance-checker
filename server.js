import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// Prefer Flash-Lite first because it is usually lighter/faster.
// You can override by setting GEMINI_MODEL in Render.
const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "gemini-2.5-flash",
  "gemini-2.0-flash"
].filter((value, index, arr) => value && arr.indexOf(value) === index);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
        title: "Gemini API connection",
        status: "Failed",
        comment: message
      }
    ],
    strengths: [],
    errors: ["The AI model could not generate a review."],
    corrections: [
      "Try again after a short time.",
      "Use a lighter model such as gemini-2.5-flash-lite.",
      "Check the Gemini API key and Render environment variables."
    ],
    correctedBalance: "No corrected balance could be generated.",
    biochemicalReasoning: "No biochemical reasoning could be generated because the Gemini API call failed.",
    assumptionsAndLimits: [
      "The checker requires a working Gemini API connection.",
      "Temporary high demand can cause a 503 error even when the code is correct."
    ],
    nextSteps: [
      "Set GEMINI_MODEL to gemini-2.5-flash-lite in Render.",
      "Redeploy the Render service.",
      "Try the review again after 1-2 minutes."
    ]
  };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const clean = String(text)
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    try {
      return JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
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
}

function buildPrompt(scenario, attempt) {
  return `
You are an expert bioprocess calculation examiner and mass balance auditor.

Task:
Review the student's fermentation or bioprocess mass balance attempt.

Check:
- calculation basis
- units
- system boundary
- input streams
- output streams
- total mass balance
- component balance
- gas terms such as CO2, O2, N2, air
- stoichiometry and balanced reaction
- yield, conversion, limiting reactant
- assumptions and missing information
- biochemical reasoning

Rules:
- Do not invent missing numerical data.
- If data are missing, mark the answer as incomplete or partially correct.
- If the student's conclusion is unsupported, state that clearly.
- If the answer is correct, still mention assumptions and limitations.
- Explain in simple student-friendly English.

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

Score must be a number from 0 to 100.

FERMENTATION / BIOPROCESS SCENARIO:
${scenario}

STUDENT MASS BALANCE ATTEMPT:
${attempt}
`;
}

async function generateWithFallback(ai, prompt) {
  let lastError = null;

  for (const model of FALLBACK_MODELS) {
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt
        });
        return {
          text: response.text || "",
          model
        };
      } catch (error) {
        lastError = error;
        const message = String(error?.message || "");
        const isTemporary = message.includes("503") || message.toLowerCase().includes("unavailable") || message.toLowerCase().includes("high demand");
        if (isTemporary && attemptNo === 1) {
          await sleep(2000);
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error("All Gemini model attempts failed.");
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

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        report: fallbackReport("GEMINI_API_KEY is missing on the server.")
      });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    const prompt = buildPrompt(scenario, attempt);
    const result = await generateWithFallback(ai, prompt);
    const parsed = tryParseJson(result.text);

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
              comment: "Gemini returned text that was not valid JSON, so it is shown as a raw review."
            }
          ],
          strengths: [],
          errors: [],
          corrections: [],
          correctedBalance: "See raw AI review below.",
          biochemicalReasoning: result.text,
          assumptionsAndLimits: ["The output format was not fully structured."],
          nextSteps: ["Try again or simplify the input."]
        },
        model: result.model
      });
    }

    return res.json({ report: parsed, model: result.model });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      report: fallbackReport(error.message || "Unknown server error")
    });
  }
});

app.listen(PORT, () => {
  console.log(`Gemini Mass Balance Checker running on port ${PORT}`);
  console.log(`Model fallback order: ${FALLBACK_MODELS.join(" -> ")}`);
});
