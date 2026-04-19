/**
 * AI Client
 * =========
 * Thin wrapper around Claude + OpenAI with a Claude→OpenAI fallback chain
 * and a richer return shape than the existing `matchingEngine.callAI`.
 *
 * Why this module exists:
 *   - `controllers/ai/matchingEngine.js` has a private `callAI(prompt)` that
 *     returns just the text string. We leave it untouched so no existing
 *     caller breaks.
 *   - The Reflection Agent needs tokens + model metadata (for cost
 *     tracking / ReflectionReport). That's what `callAIRich` provides here.
 *   - Keeps the fallback logic in one place so future consumers (e.g.
 *     admin CV analysis cache wrapper) can reuse it without duplicating
 *     provider-selection code.
 *
 * The fallback chain (in order):
 *   1. Claude (Anthropic)  — if ANTHROPIC_API_KEY is set
 *   2. OpenAI (gpt-4o)     — if OPENAI_API_KEY is set, OR Claude errored
 *   3. { text: null, ... } — caller decides what to do (retry, Affinda,
 *                            regex, manual flag, etc.)
 *
 * This module does NOT call Affinda or manual fallback — those are
 * caller-specific and belong in the caller's error-handling path.
 */

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const OPENAI_MODEL = "gpt-4o";

/**
 * @returns {{text: string|null, tokens: number, model: string, provider: "claude"|"openai"|"none", error?: string}}
 */
async function callAIRich(prompt, { maxTokens = 1500 } = {}) {
	const hasClaude = !!process.env.ANTHROPIC_API_KEY;
	const hasOpenAI = !!process.env.OPENAI_API_KEY;

	// Try Claude first
	if (hasClaude) {
		try {
			const Anthropic = require("@anthropic-ai/sdk");
			const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
			const response = await client.messages.create({
				model: ANTHROPIC_MODEL,
				max_tokens: maxTokens,
				messages: [{ role: "user", content: prompt }],
			});
			const tokens =
				(response.usage?.input_tokens || 0) +
				(response.usage?.output_tokens || 0);
			return {
				text: response.content?.[0]?.text ?? null,
				tokens,
				model: ANTHROPIC_MODEL,
				provider: "claude",
			};
		} catch (err) {
			console.error("[aiClient] Claude error, trying OpenAI fallback:", err.message);
			// fall through to OpenAI
		}
	}

	if (hasOpenAI) {
		try {
			const OpenAI = require("openai");
			const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
			const response = await client.chat.completions.create({
				model: OPENAI_MODEL,
				max_tokens: maxTokens,
				messages: [{ role: "user", content: prompt }],
			});
			const tokens =
				(response.usage?.prompt_tokens || 0) +
				(response.usage?.completion_tokens || 0);
			return {
				text: response.choices?.[0]?.message?.content ?? null,
				tokens,
				model: OPENAI_MODEL,
				provider: "openai",
			};
		} catch (err) {
			console.error("[aiClient] OpenAI error:", err.message);
			return {
				text: null,
				tokens: 0,
				model: "none",
				provider: "none",
				error: err.message,
			};
		}
	}

	return {
		text: null,
		tokens: 0,
		model: "none",
		provider: "none",
		error: "No LLM API key configured",
	};
}

/**
 * Strip common markdown fences and parse JSON from an AI response.
 * Returns null on parse failure (caller decides what to do).
 */
function parseAIJson(text) {
	if (!text) return null;
	try {
		let clean = text.trim();
		if (clean.startsWith("```json")) clean = clean.slice(7);
		else if (clean.startsWith("```")) clean = clean.slice(3);
		if (clean.endsWith("```")) clean = clean.slice(0, -3);
		clean = clean.trim();
		return JSON.parse(clean);
	} catch (err) {
		// Fallback: try to find the first {...} block
		try {
			const match = text.match(/\{[\s\S]*\}/);
			if (match) return JSON.parse(match[0]);
		} catch {}
		return null;
	}
}

module.exports = {
	callAIRich,
	parseAIJson,
	ANTHROPIC_MODEL,
	OPENAI_MODEL,
};
