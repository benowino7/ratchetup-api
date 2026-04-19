/**
 * Reflection Agent
 * ================
 * Reviews a ranked candidate list after scoring and returns an annotated
 * ReflectionReport. Never re-orders or modifies scores — purely advisory.
 *
 * Two entry points for the rest of the app:
 *   - runReflection({ job, rankedCandidates, context })
 *       Low-level: returns a plain report object. Used by admin CV analysis
 *       where we don't want to persist.
 *   - runAndPersistReflection({ job, rankedCandidates, context, rankingCacheId })
 *       Runs reflection AND persists it to the ReflectionReport table,
 *       optionally linked to an AIRankingCache row.
 *
 * The prompt always caps at top 20 candidates (predictable cost).
 * On any failure the agent fails open — returns emptyReport + logs,
 * never crashes the outer pipeline.
 */

const { prisma } = require("../../prisma");
const { callAIRich } = require("../../services/aiClient");
const {
	buildReflectionPrompt,
	parseReflectionResponse,
	emptyReport,
} = require("./reflectionHelpers");

const VALID_CONTEXTS = new Set(["RECRUITER_RANKING", "ADMIN_CV_ANALYSIS"]);

/**
 * Run reflection over a ranked candidate list. Returns a plain report
 * object (does NOT persist).
 *
 * @param {Object} job — job description shape (see reflectionHelpers)
 * @param {Array}  rankedCandidates — [{ candidateId, rank, overallScore, ... }]
 * @param {"RECRUITER_RANKING"|"ADMIN_CV_ANALYSIS"} context
 * @returns {Promise<Object>} the report (always defined)
 */
async function runReflection({ job, rankedCandidates, context }) {
	if (!VALID_CONTEXTS.has(context)) {
		console.warn(`[ReflectionAgent] Invalid context "${context}", defaulting to RECRUITER_RANKING`);
		context = "RECRUITER_RANKING";
	}

	if (!Array.isArray(rankedCandidates) || rankedCandidates.length === 0) {
		return {
			...emptyReport("No candidates to reflect on."),
			context,
			model: "none",
			tokensUsed: 0,
		};
	}

	const prompt = buildReflectionPrompt(job, rankedCandidates);

	let aiResult;
	try {
		aiResult = await callAIRich(prompt, { maxTokens: 1500 });
	} catch (err) {
		console.error("[ReflectionAgent] callAIRich threw:", err.message);
		return {
			...emptyReport(`Reflection failed (${err.message}). Manual review recommended.`),
			context,
			model: "none",
			tokensUsed: 0,
		};
	}

	if (!aiResult || !aiResult.text) {
		return {
			...emptyReport("Reflection unavailable (no LLM response). Results shown are based on scoring only."),
			context,
			model: aiResult?.model || "none",
			tokensUsed: 0,
		};
	}

	const parsed = parseReflectionResponse(aiResult.text);
	if (!parsed) {
		console.error("[ReflectionAgent] Failed to parse LLM response; raw first 200 chars:", (aiResult.text || "").slice(0, 200));
		return {
			...emptyReport("Reflection parsing failed. Results shown are based on scoring only."),
			context,
			model: aiResult.model,
			tokensUsed: aiResult.tokens || 0,
		};
	}

	const jobLabel = job?.id || job?.title || "unknown";
	console.log(
		`[ReflectionAgent] ${context} job=${jobLabel} | ` +
			`flags=${parsed.flags.length} gems=${parsed.hiddenGems.length} ` +
			`pool=${parsed.poolHealth} shortlistReady=${parsed.shortlistReady} ` +
			`tokens=${aiResult.tokens} model=${aiResult.provider}`,
	);

	return {
		...parsed,
		context,
		model: aiResult.model,
		tokensUsed: aiResult.tokens || 0,
	};
}

/**
 * Run reflection AND persist to ReflectionReport. Returns the same report
 * object plus a `reportId` field pointing at the DB row.
 *
 * `rankingCacheId` is optional — pass it for RECRUITER_RANKING to link the
 * report to the AIRankingCache row it reviewed.
 */
async function runAndPersistReflection({
	job,
	rankedCandidates,
	context,
	rankingCacheId = null,
}) {
	const report = await runReflection({ job, rankedCandidates, context });

	// Persist only when we have something useful — skip on failure cases
	// that returned the "none" model stub.
	try {
		const row = await prisma.reflectionReport.create({
			data: {
				context: report.context,
				rankingCacheId: rankingCacheId || null,
				recruiterNote: report.recruiterNote,
				flags: report.flags,
				hiddenGems: report.hiddenGems,
				overranked: report.overranked,
				hardRequirementGaps: report.hardRequirementGaps,
				anomalies: report.anomalies,
				poolHealth: report.poolHealth,
				shortlistReady: report.shortlistReady,
				suggestedShortlistSize: report.suggestedShortlistSize,
				confidence: report.confidence,
				model: report.model || "none",
				tokensUsed: report.tokensUsed || 0,
			},
		});
		return { ...report, reportId: row.id };
	} catch (err) {
		// Don't fail the caller just because persistence failed — the
		// report was still generated and can be returned inline.
		console.error("[ReflectionAgent] Persist failed:", err.message);
		return { ...report, reportId: null };
	}
}

module.exports = {
	runReflection,
	runAndPersistReflection,
};
