import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const servers = new Map();
const issuesByInstance = new Map();
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoPath = resolve(extensionDirectory, "..", "..", "..");

function execGh(args, cwd) {
    return new Promise((resolvePromise, reject) => {
        execFile("gh", args, { cwd, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }

            resolvePromise(stdout);
        });
    });
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function stripMarkdown(value) {
    return String(value ?? "")
        .replace(/\r/g, "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[#>*_~-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function extractDescription(issue) {
    const [intro] = String(issue.body ?? "").split(/##\s+Acceptance criteria/i);
    const description = stripMarkdown(intro);
    if (description.length <= 260) {
        return description || "No description supplied.";
    }

    return `${description.slice(0, 257).trim()}...`;
}

function extractAcceptanceCriteria(issue) {
    const criteria = [];
    const body = String(issue.body ?? "");
    for (const line of body.split(/\r?\n/)) {
        const match = line.match(/^\s*-\s+\[[ xX]\]\s+(.+)$/);
        if (match) {
            criteria.push(stripMarkdown(match[1]));
        }
    }

    return criteria;
}

function labelNames(issue) {
    return (issue.labels ?? []).map((label) => String(label.name ?? "").toLowerCase());
}

function recencyScore(updatedAt) {
    const updated = Date.parse(updatedAt);
    if (Number.isNaN(updated)) {
        return 0;
    }

    const ageHours = (Date.now() - updated) / (1000 * 60 * 60);
    if (ageHours <= 24) {
        return 3;
    }
    if (ageHours <= 72) {
        return 2;
    }
    if (ageHours <= 168) {
        return 1;
    }

    return 0;
}

function scoreIssue(issue) {
    const title = String(issue.title ?? "").toLowerCase();
    const labels = labelNames(issue);
    const criteria = extractAcceptanceCriteria(issue);
    const reasons = [];
    let score = recencyScore(issue.updatedAt);

    if (score > 0) {
        reasons.push("recently opened or updated");
    }

    if (labels.some((label) => /critical|priority|urgent|p0|p1/.test(label))) {
        score += 10;
        reasons.push("priority label");
    }
    if (labels.some((label) => /bug|security|regression/.test(label))) {
        score += 8;
        reasons.push("risk-focused label");
    }

    if (/filter/.test(title) && /(category|publisher)/.test(title)) {
        score += 8;
        reasons.push("unblocks high-value catalog filtering and discoverability");
    }
    if (/pagination/.test(title)) {
        score += 8;
        reasons.push("protects browse performance as the catalog grows");
    }
    if (/search|find games by title/.test(title)) {
        score += 7;
        reasons.push("addresses a core discovery path for users who know what they want");
    }
    if (/publisher page|publisher.*games/.test(title)) {
        score += 4;
        reasons.push("extends navigation using existing static routing patterns");
    }
    if (/home page|summary/.test(title)) {
        score += 3;
        reasons.push("improves landing-page context with existing data");
    }
    if (/description/.test(title)) {
        score += 2;
        reasons.push("surfaces already-modeled metadata");
    }

    if ((issue.assignees ?? []).length === 0) {
        score += 1;
        reasons.push("currently unassigned");
    }

    score += Math.min(4, criteria.length * 0.5);
    if (criteria.length >= 4) {
        reasons.push(`${criteria.length} concrete acceptance criteria`);
    }

    return { score, reasons };
}

function rankIssues(issues) {
    return issues
        .map((issue) => {
            const ranking = scoreIssue(issue);
            return {
                ...issue,
                description: extractDescription(issue),
                acceptanceCriteria: extractAcceptanceCriteria(issue),
                triageScore: ranking.score,
                justification: ranking.reasons.slice(0, 3).join("; ") || "highest current triage score",
            };
        })
        .sort((a, b) => {
            if (b.triageScore !== a.triageScore) {
                return b.triageScore - a.triageScore;
            }

            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
}

async function loadIssues(repoPath) {
    const output = await execGh(
        [
            "issue",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,body,labels,assignees,author,createdAt,updatedAt,url,comments",
        ],
        repoPath,
    );

    return rankIssues(JSON.parse(output));
}

function formatIssuePrompt(issue) {
    const criteria = issue.acceptanceCriteria.length
        ? issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
        : "No explicit acceptance criteria.";

    return `Use GitHub issue #${issue.number} as the active work context for this session.

Title: ${issue.title}
URL: ${issue.url}

Description:
${issue.description}

Acceptance criteria:
${criteria}

Why this was prioritized:
${issue.justification}

Please inspect the repository, confirm the relevant implementation path, and start working on this issue.`;
}

async function addIssueToContext(instanceId, issueNumber) {
    const issues = issuesByInstance.get(instanceId) ?? [];
    const issue = issues.find((candidate) => candidate.number === issueNumber);
    if (!issue) {
        throw new CanvasError("issue_not_loaded", `Issue #${issueNumber} is not loaded in this board.`);
    }

    await session.send({ prompt: formatIssuePrompt(issue) });
    return { added: true, issueNumber };
}

function json(res, status, payload) {
    res.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(payload));
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }

    const body = Buffer.concat(chunks).toString("utf8");
    return body ? JSON.parse(body) : {};
}

function renderCard(issue, highlighted) {
    const labels = (issue.labels ?? []).map((label) => `<span class="pill">${escapeHtml(label.name)}</span>`).join("");
    const criteria = issue.acceptanceCriteria
        .slice(0, 3)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");

    return `<article class="card ${highlighted ? "card-hot" : ""}" data-issue-number="${issue.number}">
        <div class="card-header">
            <div>
                <p class="eyebrow">Issue #${issue.number}</p>
                <h3><a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.title)}</a></h3>
            </div>
            <span class="score" title="Triage score">${issue.triageScore.toFixed(1)}</span>
        </div>
        <p>${escapeHtml(issue.description)}</p>
        ${highlighted ? `<div class="why"><strong>Why now:</strong> ${escapeHtml(issue.justification)}</div>` : ""}
        ${criteria ? `<ul>${criteria}</ul>` : ""}
        <div class="meta">
            ${labels || '<span class="pill muted">No labels</span>'}
            <span class="pill muted">Updated ${escapeHtml(new Date(issue.updatedAt).toLocaleDateString())}</span>
        </div>
        <button type="button" data-add-context="${issue.number}">Add to current context</button>
    </article>`;
}

function renderHtml() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue triage board</title>
    <style>
        :root { color-scheme: light dark; }
        body {
            margin: 0;
            background: var(--background-color-default, #0f172a);
            color: var(--text-color-default, #f8fafc);
            font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            font-size: var(--text-body-medium, 14px);
            line-height: var(--leading-body-medium, 20px);
        }
        a { color: inherit; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .wrap { padding: 24px; }
        .topbar {
            align-items: center;
            display: flex;
            gap: 16px;
            justify-content: space-between;
            margin-bottom: 20px;
        }
        h1, h2, h3, p { margin: 0; }
        h1 {
            font-size: var(--text-title-large, 26px);
            line-height: var(--leading-title-large, 32px);
        }
        h2 {
            font-size: var(--text-title-medium, 18px);
            line-height: var(--leading-title-medium, 24px);
            margin: 28px 0 12px;
        }
        .subtitle { color: var(--text-color-muted, #94a3b8); margin-top: 4px; }
        .status { color: var(--text-color-muted, #94a3b8); min-height: 20px; }
        .grid {
            display: grid;
            gap: 14px;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        }
        .card {
            background: color-mix(in srgb, var(--background-color-default, #0f172a) 86%, var(--color-white, #fff));
            border: 1px solid var(--border-color-default, #334155);
            border-radius: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 16px;
        }
        .card-hot {
            border-color: var(--true-color-blue, #60a5fa);
            box-shadow: 0 0 0 1px color-mix(in srgb, var(--true-color-blue, #60a5fa) 45%, transparent), 0 18px 60px rgba(15, 23, 42, 0.32);
        }
        .card-header {
            align-items: flex-start;
            display: flex;
            gap: 12px;
            justify-content: space-between;
        }
        .eyebrow {
            color: var(--text-color-muted, #94a3b8);
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        h3 {
            font-size: 16px;
            line-height: 22px;
            margin-top: 4px;
        }
        .score {
            background: var(--true-color-blue-muted, #1d4ed8);
            border-radius: 999px;
            color: var(--color-white, #fff);
            font-weight: 700;
            padding: 4px 8px;
        }
        .why {
            background: color-mix(in srgb, var(--true-color-blue-muted, #1d4ed8) 32%, transparent);
            border-left: 3px solid var(--true-color-blue, #60a5fa);
            border-radius: 10px;
            padding: 10px 12px;
        }
        ul { margin: 0; padding-left: 18px; }
        .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
        .pill {
            border: 1px solid var(--border-color-default, #334155);
            border-radius: 999px;
            color: var(--text-color-muted, #94a3b8);
            font-size: 12px;
            padding: 2px 8px;
        }
        .muted { opacity: 0.85; }
        button {
            align-self: flex-start;
            background: var(--true-color-blue, #2563eb);
            border: 0;
            border-radius: 10px;
            color: var(--color-white, #fff);
            cursor: pointer;
            font: inherit;
            font-weight: 700;
            padding: 9px 12px;
        }
        button:hover { filter: brightness(1.08); }
        button:focus {
            outline: 2px solid var(--color-focus-outline, #60a5fa);
            outline-offset: 2px;
        }
        button[disabled] { cursor: wait; opacity: 0.65; }
        .empty {
            border: 1px dashed var(--border-color-default, #334155);
            border-radius: 16px;
            color: var(--text-color-muted, #94a3b8);
            padding: 24px;
            text-align: center;
        }
    </style>
</head>
<body>
    <main class="wrap">
        <div class="topbar">
            <div>
                <h1>Issue triage board</h1>
                <p class="subtitle">Top cards are ranked for likely immediate attention. Use a card button to add the issue to this session.</p>
            </div>
            <button type="button" id="refresh">Refresh</button>
        </div>
        <p class="status" id="status" role="status" aria-live="polite">Loading issues...</p>
        <section aria-labelledby="hot-heading">
            <h2 id="hot-heading">Needs attention now</h2>
            <div class="grid" id="hot"></div>
        </section>
        <section aria-labelledby="remaining-heading">
            <h2 id="remaining-heading">Remaining open issues</h2>
            <div class="grid" id="remaining"></div>
        </section>
    </main>
    <script>
        const hot = document.getElementById("hot");
        const remaining = document.getElementById("remaining");
        const status = document.getElementById("status");
        const refresh = document.getElementById("refresh");

        async function requestJson(url, options) {
            const response = await fetch(url, options);
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || "Request failed");
            }
            return payload;
        }

        async function load() {
            status.textContent = "Loading issues...";
            refresh.disabled = true;
            try {
                const payload = await requestJson("/api/issues");
                hot.innerHTML = payload.topThreeHtml || '<div class="empty">No issues need attention.</div>';
                remaining.innerHTML = payload.remainingHtml || '<div class="empty">No remaining open issues.</div>';
                status.textContent = payload.count ? \`Loaded \${payload.count} open issues.\` : "No open issues found.";
            } catch (error) {
                hot.innerHTML = "";
                remaining.innerHTML = "";
                status.textContent = error.message;
            } finally {
                refresh.disabled = false;
            }
        }

        document.addEventListener("click", async (event) => {
            const button = event.target.closest("[data-add-context]");
            if (!button) {
                return;
            }

            const issueNumber = Number(button.getAttribute("data-add-context"));
            button.disabled = true;
            button.textContent = "Adding...";
            try {
                await requestJson("/api/add-context", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ issueNumber }),
                });
                button.textContent = "Added to context";
                status.textContent = \`Issue #\${issueNumber} was added to the current session.\`;
            } catch (error) {
                button.disabled = false;
                button.textContent = "Add to current context";
                status.textContent = error.message;
            }
        });

        refresh.addEventListener("click", load);
        load();
    </script>
</body>
</html>`;
}

async function startServer(instanceId, repoPath) {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (req.method === "GET" && url.pathname === "/api/issues") {
                const issues = await loadIssues(repoPath);
                issuesByInstance.set(instanceId, issues);
                const topThree = issues.slice(0, 3);
                const remaining = issues.slice(3);
                json(res, 200, {
                    count: issues.length,
                    issues,
                    remainingHtml: remaining.map((issue) => renderCard(issue, false)).join(""),
                    topThreeHtml: topThree.map((issue) => renderCard(issue, true)).join(""),
                });
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/add-context") {
                const input = await readBody(req);
                const issueNumber = Number(input.issueNumber);
                if (!Number.isInteger(issueNumber)) {
                    json(res, 400, { error: "A valid issue number is required." });
                    return;
                }

                json(res, 200, await addIssueToContext(instanceId, issueNumber));
                return;
            }

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderHtml());
        } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : "Unknown canvas error" });
        }
    });

    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { repoPath, server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "issue-triage-board",
            displayName: "Issue triage board",
            description: "A Kanban-style board that ranks open GitHub issues and can add one to the current session context.",
            inputSchema: {
                type: "object",
                properties: {
                    repoPath: {
                        type: "string",
                        description: "Absolute path to the repository whose GitHub issues should be triaged.",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "refresh_issues",
                    description: "Reload open GitHub issues and return the ranked top three plus the remaining queue.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        const repoPath = entry?.repoPath ?? defaultRepoPath;
                        const issues = await loadIssues(repoPath);
                        issuesByInstance.set(ctx.instanceId, issues);
                        return {
                            remaining: issues.slice(3).map((issue) => ({
                                number: issue.number,
                                score: issue.triageScore,
                                title: issue.title,
                                url: issue.url,
                            })),
                            topThree: issues.slice(0, 3).map((issue) => ({
                                description: issue.description,
                                justification: issue.justification,
                                number: issue.number,
                                score: issue.triageScore,
                                title: issue.title,
                                url: issue.url,
                            })),
                        };
                    },
                },
                {
                    name: "add_issue_to_context",
                    description: "Add a loaded issue to the current session context and ask the agent to begin work.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            issueNumber: { type: "integer" },
                        },
                        required: ["issueNumber"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => addIssueToContext(ctx.instanceId, Number(ctx.input.issueNumber)),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                const repoPath = typeof ctx.input?.repoPath === "string" ? ctx.input.repoPath : defaultRepoPath;
                if (!entry || entry.repoPath !== repoPath) {
                    if (entry) {
                        await new Promise((resolvePromise) => entry.server.close(() => resolvePromise()));
                    }

                    entry = await startServer(ctx.instanceId, repoPath);
                    servers.set(ctx.instanceId, entry);
                }

                return {
                    status: "Open GitHub issues ranked by likely attention needed",
                    title: "Issue triage board",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    issuesByInstance.delete(ctx.instanceId);
                    await new Promise((resolvePromise) => entry.server.close(() => resolvePromise()));
                }
            },
        }),
    ],
});
