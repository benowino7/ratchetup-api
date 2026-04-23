const crypto = require("crypto");
const { prisma } = require("../../prisma");
const {
	runAndCacheReflection,
	buildAdminCacheKey,
} = require("../ai/reflectionAgent");

// Admin CV analysis cache TTL — 72 hours per product spec. Applies per
// (cvContentHash, jobId) pair. Bypassable via ?refresh=true.
const ADMIN_CV_CACHE_TTL_MS = 72 * 60 * 60 * 1000;
const CLAUDE_CV_MODEL = "claude-sonnet-4-20250514";

function sha256Hex(s) {
	return crypto.createHash("sha256").update(s || "", "utf8").digest("hex");
}

/**
 * Analyze one or more CVs against selected jobs using Claude AI
 * Returns skill gap analysis with scoring, ranking, and detailed breakdown
 * Supports both text-based and scanned/image PDFs via Claude Vision fallback
 *
 * New (additive):
 *   - Caches each (cvContentHash, jobId) analysis in AdminCvAnalysisCache
 *     for 72h. If every requested pair is cached, Claude is skipped
 *     entirely (pure token savings).
 *   - ?refresh=true  — bypass cache, always call Claude.
 *   - ?reflect=true  — run the Reflection Agent over the assembled
 *     rankings and attach a reflection report to the response.
 */
const analyzeCv = async (req, res) => {
	try {
		// Support single file (upload.single) or multiple files (upload.array)
		const files = req.files || (req.file ? [req.file] : []);
		if (files.length === 0) {
			return res.status(400).json({ status: "FAIL", message: "At least one CV PDF file is required" });
		}

		const { jobIds } = req.body;
		if (!jobIds) {
			return res.status(400).json({ status: "FAIL", message: "jobIds is required (comma-separated or JSON array)" });
		}

		let parsedJobIds;
		try {
			parsedJobIds = typeof jobIds === "string" ? (jobIds.startsWith("[") ? JSON.parse(jobIds) : jobIds.split(",").map((s) => s.trim())) : jobIds;
		} catch {
			return res.status(400).json({ status: "FAIL", message: "Invalid jobIds format" });
		}

		if (!Array.isArray(parsedJobIds) || parsedJobIds.length === 0) {
			return res.status(400).json({ status: "FAIL", message: "At least one job ID is required" });
		}

		// Extract text from each CV PDF (with vision fallback for scanned PDFs)
		const candidates = [];
		for (const file of files) {
			const cvText = await extractCvText(file.buffer);
			if (!cvText || cvText.trim().length < 10) {
				return res.status(400).json({
					status: "FAIL",
					message: `Could not extract text from ${file.originalname || "uploaded PDF"}. The file may be corrupted or empty.`,
				});
			}
			candidates.push({
				fileName: file.originalname || "Unknown CV",
				fileSize: file.size,
				cvText,
				name: extractCandidateName(cvText),
			});
		}

		// Fetch the selected jobs with their skills
		const jobs = await prisma.job.findMany({
			where: { id: { in: parsedJobIds } },
			include: {
				company: { select: { name: true } },
				skills: { include: { skill: { select: { id: true, name: true } } } },
				industries: { include: { industry: { select: { name: true } } } },
			},
		});

		if (jobs.length === 0) {
			return res.status(404).json({ status: "FAIL", message: "No valid jobs found for the provided IDs" });
		}

		const jobSummaries = jobs.map((job) => ({
			id: job.id,
			title: job.title,
			description: (job.description || "").substring(0, 1500),
			requiredSkills: job.skills.map((s) => s.skill.name),
			industries: job.industries.map((i) => i.industry.name),
			experienceLevel: job.experienceLevel,
			employmentType: job.employmentType,
			company: job.company?.name || "Unknown",
		}));

		// Hash each CV so we can look up prior analyses in AdminCvAnalysisCache.
		for (const c of candidates) {
			c.contentHash = sha256Hex(c.cvText);
		}

		// ── Cache lookup (unless ?refresh=true) ────────────────────────────
		// For every (candidate, job) pair, look for a cached analysis that's
		// still within its 72h TTL. If we have all of them, skip Claude.
		const refresh = String(req.query.refresh || req.body.refresh || "").toLowerCase() === "true";
		const reflectOn = String(req.query.reflect || req.body.reflect || "").toLowerCase() === "true";
		const now = new Date();

		let cacheHits = {}; // { [`${hash}__${jobId}`]: { analysisJson, model, tokensUsed } }
		let totalPairs = candidates.length * jobs.length;
		let cachedCount = 0;

		if (!refresh) {
			const hashes = candidates.map((c) => c.contentHash);
			const jobIds = jobs.map((j) => j.id);
			const cacheRows = await prisma.adminCvAnalysisCache.findMany({
				where: {
					cvContentHash: { in: hashes },
					jobId: { in: jobIds },
					expiresAt: { gt: now },
				},
				select: {
					cvContentHash: true,
					jobId: true,
					analysisJson: true,
					model: true,
					tokensUsed: true,
				},
			});
			for (const r of cacheRows) {
				cacheHits[`${r.cvContentHash}__${r.jobId}`] = r;
			}
			cachedCount = Object.keys(cacheHits).length;
		}

		const cacheFullyCovers = !refresh && cachedCount === totalPairs;

		// ── Assemble the analysis result — from cache or Claude ────────────
		let analysis;
		let usedCache = false;
		let claudeTokensUsed = 0;

		if (cacheFullyCovers) {
			// All pairs cached — stitch a response without calling Claude.
			usedCache = true;
			analysis = stitchAnalysisFromCache(candidates, jobs, cacheHits);
		} else {
			// Fall through to existing Claude call (unchanged).
			// Build candidate sections for AI prompt
			const candidateSections = candidates.map((c, i) => `
### Candidate ${i + 1}: ${c.name} (File: ${c.fileName})
${c.cvText.substring(0, 5000)}
`).join("\n");

		// Call Claude for comprehensive skill gap analysis
		const Anthropic = require("@anthropic-ai/sdk");
		const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

		const response = await client.messages.create({
			model: "claude-sonnet-4-20250514",
			max_tokens: 8000,
			messages: [
				{
					role: "user",
					content: `You are an expert HR analyst and recruitment specialist. Analyze each candidate's CV against each job posting and provide a comprehensive skill gap analysis with scoring and ranking.

## Candidates:
${candidateSections}

## Jobs to Analyze Against:
${JSON.stringify(jobSummaries, null, 2)}

For EACH combination of candidate and job, provide a detailed analysis. Return a JSON object with this structure:
{
  "candidates": [
    {
      "candidateIndex": 0,
      "candidateName": "Name from CV",
      "fileName": "filename.pdf",
      "analyses": [
        {
          "jobId": "the job id",
          "jobTitle": "the job title",
          "company": "company name",
          "overallScore": 0-100,
          "matchLevel": "Excellent Match" | "Strong Match" | "Partial Match" | "Weak Match",
          "tier": "excellent" | "strong" | "moderate" | "weak",
          "scoreBreakdown": {
            "skillMatch": 0-100,
            "experienceMatch": 0-100,
            "educationMatch": 0-100,
            "overallFit": 0-100
          },
          "matchedSkills": ["skill1", "skill2"],
          "missingSkills": ["skill3", "skill4"],
          "transferableSkills": ["skill that could transfer"],
          "skillGapAnalysis": "Detailed paragraph explaining the skill gaps, strengths, and what training or upskilling would bridge the gap",
          "experienceMatch": "How well the candidate's experience level and years match the role requirements",
          "educationMatch": "How the candidate's education aligns with the role",
          "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
          "weaknesses": ["specific gap 1", "specific gap 2"],
          "redFlags": ["any concerns if applicable"],
          "greenFlags": ["positive indicators"],
          "recommendation": "Detailed recommendation: should they be interviewed? What questions to ask? What to probe?",
          "interviewTalkingPoints": ["specific question 1", "specific question 2", "specific question 3"],
          "recruiterSummary": "3-4 sentence executive summary for the hiring manager explaining why this candidate does or doesn't fit"
        }
      ]
    }
  ],
  "rankings": [
    {
      "rank": 1,
      "candidateName": "Best candidate name",
      "candidateIndex": 0,
      "averageScore": 85,
      "topJobMatch": "Job Title with highest score",
      "summary": "Why this candidate is ranked here"
    }
  ]
}

Scoring guide:
- 85-100 (Excellent): Has virtually all required skills, strong relevant experience, ideal fit
- 70-84 (Strong): Has most key skills, solid experience, minor gaps that are easily addressed
- 50-69 (Moderate/Partial): Has some relevant skills but significant gaps; may need training
- 0-49 (Weak): Lacks most required skills; poor fit for the role

Be thorough, specific, and actionable. Reference specific skills and experiences from the CV.
Return ONLY valid JSON, no markdown or explanation.`,
				},
			],
		});

		const content = response.content[0].text;
		claudeTokensUsed =
			(response.usage?.input_tokens || 0) +
			(response.usage?.output_tokens || 0);
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			analysis = JSON.parse(jsonMatch ? jsonMatch[0] : content);
		} catch {
			// Fallback: try array format for backwards compatibility
			try {
				const arrayMatch = content.match(/\[[\s\S]*\]/);
				const arr = JSON.parse(arrayMatch ? arrayMatch[0] : content);
				// Convert old format to new format
				analysis = {
					candidates: [{
						candidateIndex: 0,
						candidateName: candidates[0]?.name || "Unknown",
						fileName: candidates[0]?.fileName || "Unknown",
						analyses: arr,
					}],
					rankings: [{
						rank: 1,
						candidateName: candidates[0]?.name || "Unknown",
						candidateIndex: 0,
						averageScore: Math.round(arr.reduce((s, a) => s + (a.overallScore || 0), 0) / arr.length),
						topJobMatch: arr.sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0))[0]?.jobTitle || "",
						summary: "Single candidate analyzed",
					}],
				};
			} catch {
				return res.status(422).json({
					status: "FAIL",
					message: "Failed to parse AI analysis response",
					rawResponse: content.substring(0, 2000),
				});
			}
		}
		}   // ← closes the `else` (Claude path) opened earlier for cache miss

		// Sort each candidate's analyses by score (applies to cache + Claude)
		if (analysis?.candidates) {
			for (const candidate of analysis.candidates) {
				if (candidate.analyses) {
					candidate.analyses.sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0));
				}
			}
		}

		// Sort rankings
		if (analysis?.rankings) {
			analysis.rankings.sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0));
			analysis.rankings.forEach((r, i) => r.rank = i + 1);
		}

		// ── Cache writes — only when we actually went to Claude ───────────
		let cacheWrites = 0;
		if (!usedCache && analysis?.candidates) {
			const expiresAt = new Date(Date.now() + ADMIN_CV_CACHE_TTL_MS);
			const perPairTokens =
				candidates.length > 0
					? Math.ceil(claudeTokensUsed / Math.max(candidates.length * jobs.length, 1))
					: 0;
			for (const candidateBlock of analysis.candidates) {
				const candidate = candidates[candidateBlock.candidateIndex];
				if (!candidate) continue;
				const hash = candidate.contentHash;
				for (const pairAnalysis of candidateBlock.analyses || []) {
					if (!pairAnalysis.jobId) continue;
					try {
						await prisma.adminCvAnalysisCache.upsert({
							where: {
								cvContentHash_jobId: {
									cvContentHash: hash,
									jobId: pairAnalysis.jobId,
								},
							},
							update: {
								analysisJson: pairAnalysis,
								model: CLAUDE_CV_MODEL,
								tokensUsed: perPairTokens,
								analyzedAt: new Date(),
								expiresAt,
								cvFileName: candidate.fileName,
								candidateName: candidate.name,
							},
							create: {
								cvContentHash: hash,
								jobId: pairAnalysis.jobId,
								cvFileName: candidate.fileName,
								candidateName: candidate.name,
								analysisJson: pairAnalysis,
								model: CLAUDE_CV_MODEL,
								tokensUsed: perPairTokens,
								expiresAt,
							},
						});
						cacheWrites++;
					} catch (err) {
						console.error(
							`[AdminCvCache] upsert failed for hash=${hash.slice(0, 8)} job=${pairAnalysis.jobId}:`,
							err.message,
						);
					}
				}
			}
		}

		// ── Optional reflection (opt-in via ?reflect=true) ─────────────────
		// Reflections are persisted for 72h keyed by (cv hashes + job ids),
		// so repeat admin clicks within that window reuse the saved report.
		// Pass ?reflectRefresh=true to regenerate before the TTL.
		let reflectionReport = null;
		const reflectRefresh = String(req.query.reflectRefresh || req.body.reflectRefresh || "").toLowerCase() === "true";
		if (reflectOn && Array.isArray(analysis?.rankings) && analysis.rankings.length > 0) {
			try {
				const rankedCandidates = analysis.rankings.map((r) => {
					const candBlock = (analysis.candidates || []).find(
						(c) => c.candidateIndex === r.candidateIndex,
					);
					const topAnalysis = candBlock?.analyses?.[0] || {};
					return {
						candidateId: candBlock?.fileName || `candidate_${r.candidateIndex}`,
						rank: r.rank,
						overallScore: r.averageScore,
						tier: topAnalysis.tier || "moderate",
						matchedItems: topAnalysis.matchedSkills || [],
						criticalGaps: topAnalysis.missingSkills || [],
						transferableSkills: topAnalysis.transferableSkills || [],
						concerns: topAnalysis.redFlags || [],
					};
				});
				const reflectionJob = {
					id: jobs[0]?.id,
					title: jobs.length === 1 ? jobs[0].title : `${jobs.length} jobs analyzed together`,
					company: jobs[0]?.company?.name,
					// Concatenate job descriptions so the requirements auto-gen
					// has text to work with when skills lists are empty.
					description: jobs
						.map((j) => `# ${j.title}\n${j.description || ""}`)
						.join("\n\n---\n\n"),
					requiredSkills: jobs.flatMap((j) => j.skills.map((s) => s.skill.name)),
					preferredSkills: [],
					keywords: [],
				};
				const cacheKey = buildAdminCacheKey({
					cvHashes: candidates.map((c) => c.contentHash),
					jobIds: jobs.map((j) => j.id),
				});
				reflectionReport = await runAndCacheReflection({
					job: reflectionJob,
					rankedCandidates,
					context: "ADMIN_CV_ANALYSIS",
					cacheKey,
					forceRefresh: reflectRefresh,
				});
			} catch (err) {
				console.error("[AdminCvAnalysis] Reflection failed:", err.message);
				reflectionReport = null;
			}
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: "CV analysis completed",
			data: {
				candidates: analysis.candidates || [],
				rankings: analysis.rankings || [],
				totalCandidates: candidates.length,
				totalJobsAnalyzed: jobs.length,
				cache: {
					hit: usedCache,
					hits: cachedCount,
					totalPairs,
					writes: cacheWrites,
					ttlHours: 72,
				},
				...(reflectionReport ? { reflection: reflectionReport } : {}),
			},
		});
	} catch (error) {
		console.error("CV analysis error:", error);
		return res.status(500).json({ status: "ERROR", message: error.message || "Failed to analyze CV" });
	}
};

/**
 * Stitch an analysis response from the AdminCvAnalysisCache rows when every
 * (candidate, job) pair is already cached. Skips Claude entirely — pure
 * token savings on repeat admin clicks within the 72h TTL window.
 */
function stitchAnalysisFromCache(candidates, jobs, cacheHits) {
	const candidatesOut = candidates.map((c, idx) => {
		const analyses = jobs
			.map((j) => {
				const row = cacheHits[`${c.contentHash}__${j.id}`];
				return row ? row.analysisJson : null;
			})
			.filter(Boolean);

		return {
			candidateIndex: idx,
			candidateName: c.name || "Unknown",
			fileName: c.fileName,
			analyses,
		};
	});

	const rankings = candidatesOut.map((cb, idx) => {
		const scores = (cb.analyses || []).map((a) => a.overallScore || 0);
		const avg = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;
		const top = (cb.analyses || []).reduce(
			(best, a) => ((a.overallScore || 0) > (best?.overallScore || 0) ? a : best),
			null,
		);
		return {
			rank: idx + 1, // will be re-sorted below
			candidateName: cb.candidateName,
			candidateIndex: idx,
			averageScore: avg,
			topJobMatch: top?.jobTitle || "",
			summary: "Loaded from cache (analyzed within last 72h)",
		};
	});

	return { candidates: candidatesOut, rankings };
}

/**
 * Extract text from PDF buffer, with Claude Vision fallback for scanned/image PDFs
 */
async function extractCvText(pdfBuffer) {
	// Try text extraction first
	try {
		const originalJSONParse = JSON.parse;
		const pdfParse = require("pdf-parse");
		JSON.parse = originalJSONParse;

		const pdfData = await pdfParse(pdfBuffer);
		const text = typeof pdfData.text === "string" ? pdfData.text : String(pdfData.text || "");

		if (text.trim().length >= 50) {
			return text;
		}
	} catch (e) {
		console.log("pdf-parse failed, trying vision fallback:", e.message);
	}

	// Fallback: use Claude Vision to read the PDF as base64
	try {
		const Anthropic = require("@anthropic-ai/sdk");
		const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

		const base64Pdf = pdfBuffer.toString("base64");

		const response = await client.messages.create({
			model: "claude-sonnet-4-20250514",
			max_tokens: 4000,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "document",
							source: {
								type: "base64",
								media_type: "application/pdf",
								data: base64Pdf,
							},
						},
						{
							type: "text",
							text: "Extract ALL text content from this CV/resume document. Return the complete text exactly as it appears, preserving the structure. Include name, contact info, education, work experience, skills, certifications - everything. Return ONLY the extracted text, no commentary.",
						},
					],
				},
			],
		});

		const extractedText = response.content[0].text;
		if (extractedText && extractedText.trim().length >= 20) {
			return extractedText;
		}
	} catch (e) {
		console.error("Claude Vision PDF extraction failed:", e.message);
	}

	return "";
}

/**
 * Best-effort candidate-name extractor from raw CV text.
 *
 * Handles the two common failure modes of the previous one-line heuristic:
 *  - A "Curriculum Vitae" prefix/suffix on the first line (eg. "Benson
 *    Owino • Curriculum Vitae" or "Curriculum Vitae Jose Carlos Guimaraes"),
 *  - ALL-CAPS names (converted to Title Case),
 *  - Name split across separators (bullet, pipe, tabs, multiple spaces),
 *  - Accented / non-ASCII letters (unicode letter class),
 *  - Garbage first lines (emails, phone numbers, addresses) by scanning
 *    the first eight non-empty lines.
 */
function extractCandidateName(text) {
	if (!text) return "Unknown Candidate";

	const BAD_WORDS = new Set([
		"curriculum", "vitae", "resume", "cv", "personal", "information",
		"contact", "details", "profile", "summary", "professional",
		"objective", "experience", "education", "skills", "page",
		"name", "date", "birth", "nationality", "address", "email",
		"phone", "mobile", "linkedin",
	]);

	const stripBoilerplate = (s) =>
		s
			.replace(/^[\s•·|:_-]*curriculum\s+vitae[\s•·|:_-]*/i, "")
			.replace(/[\s•·|:_-]*curriculum\s+vitae[\s•·|:_-]*$/i, "")
			.replace(/^[\s•·|:_-]*resume[\s•·|:_-]+/i, "")
			.replace(/^[\s•·|:_-]*cv[\s•·|:_-]+/i, "")
			.replace(/\s+/g, " ")
			.trim();

	const splitTokens = (s) =>
		s.split(/[|•·\t]|\s{3,}/).map((x) => x.trim()).filter(Boolean);

	const looksLikeName = (s) => {
		if (!s) return false;
		if (s.length < 4 || s.length > 60) return false;
		if (/[\d@]/.test(s)) return false;
		if (!/^[\p{L}\s'.-]+$/u.test(s)) return false;
		const words = s.split(/\s+/).filter(Boolean);
		if (words.length < 2 || words.length > 5) return false;
		for (const w of words) {
			if (BAD_WORDS.has(w.toLowerCase())) return false;
			if (!/^[\p{L}][\p{L}'.-]*$/u.test(w)) return false;
		}
		return true;
	};

	const titleCase = (s) =>
		s.toLowerCase().replace(/(^|\s|['-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());

	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	for (const raw of lines.slice(0, 8)) {
		const stripped = stripBoilerplate(raw);
		const cands = [stripped, ...splitTokens(stripped)];
		for (const c of cands) {
			if (looksLikeName(c)) {
				return c === c.toUpperCase() ? titleCase(c) : c;
			}
		}
	}

	return "Unknown Candidate";
}

/**
 * Get all published jobs for the CV analysis job selector
 */
const getJobsForAnalysis = async (req, res) => {
	try {
		const { search, page = 1, limit = 50 } = req.query;
		const skip = (Number(page) - 1) * Number(limit);

		// Load all published jobs (admin + recruiter posted)
		const where = { status: "PUBLISHED" };
		if (search) {
			where.AND = [
				{ OR: [
					{ title: { contains: search, mode: "insensitive" } },
					{ company: { name: { contains: search, mode: "insensitive" } } },
				] },
			];
		}

		const [jobs, total] = await Promise.all([
			prisma.job.findMany({
				where,
				skip,
				take: Number(limit),
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					title: true,
					employmentType: true,
					experienceLevel: true,
					company: { select: { name: true } },
					skills: { include: { skill: { select: { name: true } } } },
				},
			}),
			prisma.job.count({ where }),
		]);

		return res.status(200).json({
			status: "SUCCESS",
			data: jobs,
			meta: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) },
		});
	} catch (error) {
		console.error("Get jobs for analysis error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to fetch jobs" });
	}
};

module.exports = {
	analyzeCv,
	getJobsForAnalysis,
};
