import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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
        title: "Gemini API connection",
        status: "Failed",
        comment: message
      }
    ],
    strengths: [],
    errors: ["The AI model could not generate a review."],
    corrections: ["Check the Gemini API key, model name, and Render deployment logs, then try again."],
    correctedBalance: "No corrected balance could be generated.",
    biochemicalReasoning: "No biochemical reasoning could be generated because the Gemini API call failed.",
    assumptionsAndLimits: [
      "The checker requires a working Gemini API connection.",
      "The user must provide a clear scenario and mass balance attempt."
    ],
    nextSteps: [
      "Verify that GEMINI_API_KEY is set in Render Environment Variables.",
      "Verify that GEMINI_MODEL is set to gemini-2.5-flash.",
      "Redeploy the Render service.",
      "Try the review again."
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

    const prompt = `
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

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt
    });

    const text = response.text || "";
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
              comment: "Gemini returned text that was not valid JSON, so it is shown as a raw review."
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
  console.log(`Gemini Mass Balance Checker running on port ${PORT}`);
});
