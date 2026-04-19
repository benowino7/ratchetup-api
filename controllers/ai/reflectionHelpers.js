/**
 * Reflection Helpers
 * ==================
 * Pure functions (no I/O) for building the reflection prompt from
 * a ranked candidate list and parsing Claude's JSON response.
 *
 * Kept separate from reflectionAgent.js so it's easy to unit-test
 * without spinning up an LLM call.
 */

/**
 * Build a reflection prompt for an experienced recruiter persona.
 * Caps input at top 20 candidates to keep token cost predictable.
 *
 * @param {Object} job — { id, title, company, location, minYearsExperience,
 *                         educationRequirement, requiredSkills[],
 *                         preferredSkills[], keywords[] }
 * @param {Array}  rankedCandidates — [{ candidateId, rank, overallScore,
 *                         tier, matchedItems[], criticalGaps[],
 *                         transferableSkills[], concerns[] }, ...]
 * @returns {string}
 */
function buildReflectionPrompt(job, rankedCandidates) {
	const top = rankedCandidates.slice(0, 20);

	const jobBlock = [
		`ROLE: ${job.title || "Unknown role"}${job.company ? " at " + job.company : ""}`,
		`Location: ${job.location || "Not specified"}`,
		`Min experience: ${job.minYearsExperience ?? "Not specified"} years`,
		`Education required: ${job.educationRequirement || "Not specified"}`,
		`Required skills: ${(job.requiredSkills || []).slice(0, 20).join(", ") || "None listed"}`,
		`Preferred skills: ${(job.preferredSkills || []).slice(0, 10).join(", ") || "None listed"}`,
		`Keywords / ATS: ${(job.keywords || []).slice(0, 15).join(", ") || "None listed"}`,
	].join("\n");

	const candidateLines = top.map((r) => {
		const matched = (r.matchedItems || []).slice(0, 5).join(", ") || "none";
		const gaps = (r.criticalGaps || []).slice(0, 4).join(", ") || "none";
		const transferable = (r.transferableSkills || []).slice(0, 3).join(", ") || "none";
		const concerns = (r.concerns || []).slice(0, 2).join("; ") || "none";
		const rank = String(r.rank ?? "?").padStart(2);
		const score = typeof r.overallScore === "number" ? r.overallScore.toFixed(1) : "N/A";
		return `  Rank ${rank} | ${String(r.candidateId || "").padEnd(24).slice(0, 24)} | Score: ${score.padStart(5)} | Tier: ${(r.tier || "?").padEnd(10)} | Matched: ${matched} | Gaps: ${gaps} | Transferable: ${transferable} | Concerns: ${concerns}`;
	}).join("\n");

	const scores = rankedCandidates.map((r) => r.overallScore).filter((s) => typeof s === "number");
	const topScore = scores.length ? Math.max(...scores) : 0;
	const bottomScore = scores.length ? Math.min(...scores) : 0;
	const byTier = { excellent: 0, strong: 0, moderate: 0, weak: 0 };
	for (const r of rankedCandidates) {
		const t = (r.tier || "").toLowerCase();
		if (t in byTier) byTier[t]++;
	}

	const statsBlock = [
		`Total candidates: ${rankedCandidates.length}`,
		`Score range: ${bottomScore.toFixed(1)} – ${topScore.toFixed(1)}`,
		`Tier breakdown: Excellent=${byTier.excellent}, Strong=${byTier.strong}, Moderate=${byTier.moderate}, Weak=${byTier.weak}`,
		`Top 3 scores: ${rankedCandidates.slice(0, 3).map((r) => (r.overallScore || 0).toFixed(1)).join(", ")}`,
	].join("\n");

	return `You are a senior technical recruiter reviewing a ranked candidate list before it goes to the hiring manager.

You have been given:
1. The job requirements
2. A ranked list of candidates with their scores, matched skills, gaps, and concerns
3. Statistical distribution of the scores

Your task is to reflect on this list as a whole and identify anything that a purely algorithmic scoring system might miss.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
JOB REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${jobBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCORE STATISTICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${statsBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RANKED CANDIDATES (top 20)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${candidateLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFLECTION INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review this list and identify:

1. HIDDEN GEMS — candidates ranked outside the top 3 whose profile suggests
   they may be stronger than their score indicates. Look for: unusual career
   trajectories, highly specialised experience the formula may have missed,
   transferable skills that closely cover gaps, or overqualification that
   signals capacity beyond the role.

2. OVERRANKED CANDIDATES — candidates in the top 3-5 whose score seems
   inflated. Look for: keyword matches without depth of experience, seniority
   mismatches, profiles that match the JD words but not the role context.

3. HARD REQUIREMENT GAPS — check the top-ranked candidates against the job's
   hard requirements. Flag any top-ranked candidate who appears to be missing
   a non-negotiable requirement even though their score is high.

4. ANOMALIES — anything structurally unusual:
   - All candidates scoring below 50 (thin/impossible-to-fill pool)
   - Top candidate scores far higher than everyone else (one obvious hire)
   - All top candidates nearly identical profiles (no diversity of approach)
   - Large score cliff between rank N and rank N+1

5. POOL HEALTH — is this a strong, adequate, thin, or critical talent pool
   for this specific role?

6. SHORTLIST RECOMMENDATION — how many candidates should actually be
   shortlisted? A typical shortlist is 3-6. Sometimes the right answer is 1
   or 10.

Return ONLY valid JSON (no markdown, no explanation):
{
  "recruiter_note": "2-4 sentence plain-English summary the recruiter reads first. Be direct and specific. Mention the role title.",
  "flags": [
    {
      "severity": "info | warning | critical",
      "flag_type": "hidden_gem | overranked | hard_requirement_gap | anomaly | thin_pool | cluster | seniority_mismatch",
      "candidate_id": "candidate_id or null if about the list as a whole",
      "rank": <rank number or null>,
      "message": "plain English description of the flag — what the recruiter should do or know"
    }
  ],
  "hidden_gems": ["candidate_id_1", "candidate_id_2"],
  "overranked": ["candidate_id_1"],
  "anomalies": ["plain description 1", "plain description 2"],
  "hard_requirement_gaps": [
    {"candidate_id": "...", "rank": 2, "missing": "specific requirement"}
  ],
  "pool_health": "strong | adequate | thin | critical",
  "shortlist_ready": true,
  "suggested_shortlist_size": 5,
  "confidence": "high | medium | low"
}

Be honest. Do not inflate confidence. A recruiter will act on this.
If nothing unusual is found, say so clearly in the recruiter_note and return empty arrays.`;
}

/**
 * Parse the JSON response from the LLM into a normalized ReflectionReport
 * shape (camelCase, defaults filled in). Never throws — always returns
 * a usable object.
 *
 * @param {string|null} rawText
 * @returns {Object|null} null if totally unparseable
 */
function parseReflectionResponse(rawText) {
	if (!rawText) return null;

	let data = null;
	try {
		let clean = rawText.trim();
		if (clean.startsWith("```json")) clean = clean.slice(7);
		else if (clean.startsWith("```")) clean = clean.slice(3);
		if (clean.endsWith("```")) clean = clean.slice(0, -3);
		data = JSON.parse(clean.trim());
	} catch {
		try {
			const match = rawText.match(/\{[\s\S]*\}/);
			if (match) data = JSON.parse(match[0]);
		} catch {}
	}

	if (!data || typeof data !== "object") return null;

	return {
		recruiterNote: String(data.recruiter_note || ""),
		flags: Array.isArray(data.flags) ? data.flags : [],
		hiddenGems: Array.isArray(data.hidden_gems) ? data.hidden_gems : [],
		overranked: Array.isArray(data.overranked) ? data.overranked : [],
		hardRequirementGaps: Array.isArray(data.hard_requirement_gaps)
			? data.hard_requirement_gaps
			: [],
		anomalies: Array.isArray(data.anomalies) ? data.anomalies : [],
		poolHealth: ["strong", "adequate", "thin", "critical"].includes(data.pool_health)
			? data.pool_health
			: "adequate",
		shortlistReady: typeof data.shortlist_ready === "boolean" ? data.shortlist_ready : true,
		suggestedShortlistSize:
			Number.isInteger(data.suggested_shortlist_size) &&
				data.suggested_shortlist_size >= 1 &&
				data.suggested_shortlist_size <= 10
				? data.suggested_shortlist_size
				: 5,
		confidence: ["high", "medium", "low"].includes(data.confidence) ? data.confidence : "medium",
	};
}

/**
 * A safe minimal report when reflection can't complete. Matches the same
 * shape parseReflectionResponse returns, so callers don't need to null-check.
 */
function emptyReport(noteText) {
	return {
		recruiterNote: noteText || "Reflection unavailable. Manual review recommended.",
		flags: [],
		hiddenGems: [],
		overranked: [],
		hardRequirementGaps: [],
		anomalies: [],
		poolHealth: "adequate",
		shortlistReady: true,
		suggestedShortlistSize: 5,
		confidence: "low",
	};
}

module.exports = {
	buildReflectionPrompt,
	parseReflectionResponse,
	emptyReport,
};
