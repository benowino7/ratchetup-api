/**
 * Reflection Agent
 * ================
 * Reviews a ranked candidate list after scoring and returns an annotated
 * ReflectionReport. Never re-orders or modifies scores — purely advisory.
 *
 * Entry points:
 *   - runReflection({ job, rankedCandidates, context })
 *       Low-level: returns a plain report object. No persistence.
 *   - runAndPersistReflection({ job, rankedCandidates, context, rankingCacheId })
 *       Runs reflection AND always persists / upserts.
 *   - runAndCacheReflection({ job, rankedCandidates, context, rankingCacheId, cacheKey, forceRefresh })
 *       Preferred entry. Checks the DB for a fresh (≤72h) report first
 *       and returns it unchanged — saves token/LLM call on repeat clicks.
 *       Regenerates + upserts only when stale, missing, or forceRefresh.
 *
 * The prompt always caps at top 20 candidates (predictable cost).
 * Requirements are auto-derived from the job description when the job
 * lacks explicit requiredSkills/keywords.
 * On any failure the agent fails open — returns emptyReport + logs,
 * never crashes the outer pipeline.
 */

const crypto = require("crypto");
const { prisma } = require("../../prisma");
const { callAIRich } = require("../../services/aiClient");
const {
	buildReflectionPrompt,
	parseReflectionResponse,
	emptyReport,
} = require("./reflectionHelpers");

const VALID_CONTEXTS = new Set(["RECRUITER_RANKING", "ADMIN_CV_ANALYSIS"]);
const REFLECTION_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

// ──────────────────────────────────────────────────────────────────────
// Requirement synthesis (when a job has no requiredSkills / keywords
// we ask the LLM to derive 3–10 from the job description).
// ──────────────────────────────────────────────────────────────────────

/**
 * If the job lacks explicit requirements, derive 3–10 items from its
 * description via a cheap LLM call. Returns the (possibly-mutated) job
 * object with `requiredSkills` filled. Fails open — returns the original
 * job on any error. Never over-calls: if either requiredSkills OR keywords
 * is non-empty, skips the LLM entirely.
 */
async function ensureJobRequirements(job) {
	if (!job) return job;
	const hasRequirements =
		(Array.isArray(job.requiredSkills) && job.requiredSkills.length > 0) ||
		(Array.isArray(job.keywords) && job.keywords.length > 0) ||
		(Array.isArray(job.preferredSkills) && job.preferredSkills.length > 0);
	if (hasRequirements) return job;

	const description = (job.description || "").trim();
	if (description.length < 40) {
		// Not enough JD text to derive anything useful.
		return job;
	}

	const prompt = `You are extracting the non-negotiable requirements for a job posting so a recruiter's tools can evaluate applicants against them.

Job title: ${job.title || "Unknown"}
Job description:
"""
${description.slice(0, 4000)}
"""

Extract the concrete requirements (skills, credentials, tools, domain expertise) a candidate MUST or SHOULD have. Aim for the most specific, shortlistable items — not generic soft skills. Between 3 and 10 items total. Each item must be a short noun phrase (1–4 words).

Return ONLY a JSON array of strings, no explanation, no markdown:
["item 1", "item 2", ...]`;

	try {
		const result = await callAIRich(prompt, { maxTokens: 400 });
		if (!result?.text) return job;
		let parsed = null;
		try {
			let clean = result.text.trim();
			if (clean.startsWith("```json")) clean = clean.slice(7);
			else if (clean.startsWith("```")) clean = clean.slice(3);
			if (clean.endsWith("```")) clean = clean.slice(0, -3);
			parsed = JSON.parse(clean.trim());
		} catch {
			const m = result.text.match(/\[[\s\S]*\]/);
			if (m) {
				try { parsed = JSON.parse(m[0]); } catch {}
			}
		}
		if (!Array.isArray(parsed)) return job;

		const clean = parsed
			.map((x) => (typeof x === "string" ? x.trim() : ""))
			.filter((x) => x.length >= 2 && x.length <= 60)
			.slice(0, 10);

		if (clean.length < 3) return job;
		console.log(`[ReflectionAgent] Derived ${clean.length} requirements from description for job=${job.id || "?"}`);
		return { ...job, requiredSkills: clean, requirementsDerived: true };
	} catch (err) {
		console.error("[ReflectionAgent] ensureJobRequirements failed:", err.message);
		return job;
	}
}

/**
 * Run reflection over a ranked candidate list. Returns a plain report
 * object (does NOT persist).
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

	const enrichedJob = await ensureJobRequirements(job);
	const prompt = buildReflectionPrompt(enrichedJob, rankedCandidates);

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

	const jobLabel = enrichedJob?.id || enrichedJob?.title || "unknown";
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
		requirementsDerived: enrichedJob?.requirementsDerived === true,
		requirementsUsed: enrichedJob?.requiredSkills || [],
	};
}

/**
 * Normalize a persisted ReflectionReport row into the same shape the
 * live agent returns, so the frontend never has to know the difference.
 */
function rowToReport(row) {
	if (!row) return null;
	return {
		recruiterNote: row.recruiterNote,
		flags: Array.isArray(row.flags) ? row.flags : (row.flags || []),
		hiddenGems: Array.isArray(row.hiddenGems) ? row.hiddenGems : (row.hiddenGems || []),
		overranked: Array.isArray(row.overranked) ? row.overranked : (row.overranked || []),
		hardRequirementGaps: Array.isArray(row.hardRequirementGaps)
			? row.hardRequirementGaps
			: (row.hardRequirementGaps || []),
		anomalies: Array.isArray(row.anomalies) ? row.anomalies : (row.anomalies || []),
		poolHealth: row.poolHealth,
		shortlistReady: row.shortlistReady,
		suggestedShortlistSize: row.suggestedShortlistSize,
		confidence: row.confidence,
		context: row.context,
		model: row.model,
		tokensUsed: row.tokensUsed,
		reportId: row.id,
		generatedAt: row.createdAt?.toISOString?.() || row.createdAt,
		expiresAt: row.expiresAt?.toISOString?.() || row.expiresAt,
		cached: true,
	};
}

/**
 * Look up a fresh (unexpired) persisted report.
 */
async function findFreshReport({ rankingCacheId, cacheKey, context }) {
	const now = new Date();
	try {
		if (rankingCacheId) {
			const row = await prisma.reflectionReport.findUnique({
				where: { rankingCacheId },
			});
			if (row && (!row.expiresAt || row.expiresAt > now)) return row;
			return null;
		}
		if (cacheKey) {
			const row = await prisma.reflectionReport.findFirst({
				where: {
					cacheKey,
					context: context || undefined,
					expiresAt: { gt: now },
				},
				orderBy: { createdAt: "desc" },
			});
			return row || null;
		}
	} catch (err) {
		console.error("[ReflectionAgent] findFreshReport error:", err.message);
	}
	return null;
}

/**
 * Run reflection AND persist. Does NOT check for prior cached reports —
 * always generates a new report. Used for legacy paths.
 */
async function runAndPersistReflection({
	job,
	rankedCandidates,
	context,
	rankingCacheId = null,
	cacheKey = null,
}) {
	const report = await runReflection({ job, rankedCandidates, context });
	const now = new Date();
	const expiresAt = new Date(now.getTime() + REFLECTION_TTL_MS);

	try {
		const baseData = {
			context: report.context,
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
			cacheKey: cacheKey || null,
			expiresAt,
		};

		let row;
		if (rankingCacheId) {
			// Upsert on the unique rankingCacheId so repeats overwrite.
			row = await prisma.reflectionReport.upsert({
				where: { rankingCacheId },
				create: { ...baseData, rankingCacheId },
				update: baseData,
			});
		} else {
			row = await prisma.reflectionReport.create({ data: baseData });
		}
		return {
			...report,
			reportId: row.id,
			generatedAt: row.createdAt?.toISOString?.() || now.toISOString(),
			expiresAt: row.expiresAt?.toISOString?.() || expiresAt.toISOString(),
			cached: false,
		};
	} catch (err) {
		console.error("[ReflectionAgent] Persist failed:", err.message);
		return { ...report, reportId: null, expiresAt: expiresAt.toISOString(), cached: false };
	}
}

/**
 * Preferred entry point. Checks for a fresh cached report first
 * (within 72h TTL); only regenerates when missing / stale / forceRefresh.
 *
 * Returns the same shape as runReflection + { reportId, expiresAt, cached }.
 */
async function runAndCacheReflection({
	job,
	rankedCandidates,
	context,
	rankingCacheId = null,
	cacheKey = null,
	forceRefresh = false,
}) {
	if (!forceRefresh) {
		const fresh = await findFreshReport({ rankingCacheId, cacheKey, context });
		if (fresh) {
			console.log(
				`[ReflectionAgent] Cache hit context=${context} ` +
					`key=${cacheKey ? cacheKey.slice(0, 8) : "—"} cacheId=${rankingCacheId || "—"} ` +
					`expiresAt=${fresh.expiresAt?.toISOString?.() || "none"}`,
			);
			return rowToReport(fresh);
		}
	}
	return runAndPersistReflection({
		job,
		rankedCandidates,
		context,
		rankingCacheId,
		cacheKey,
	});
}

/**
 * Build a deterministic cacheKey for admin CV analysis from the set of
 * CV content hashes and job ids being analyzed together.
 */
function buildAdminCacheKey({ cvHashes = [], jobIds = [] }) {
	const h = crypto.createHash("sha256");
	h.update(cvHashes.slice().sort().join("|"));
	h.update("::");
	h.update(jobIds.slice().sort().join("|"));
	return h.digest("hex");
}

module.exports = {
	runReflection,
	runAndPersistReflection,
	runAndCacheReflection,
	findFreshReport,
	buildAdminCacheKey,
	ensureJobRequirements,
	REFLECTION_TTL_MS,
};
