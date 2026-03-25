export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // format: "owner/repo-name"
  const branch = process.env.GITHUB_BRANCH || "main";
  const filePath = "data.json";

  if (!token || !repo) {
    return res.status(500).json({ error: "Server not configured: missing GITHUB_TOKEN or GITHUB_REPO" });
  }

  const [owner, repoName] = repo.split("/");
  const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`;
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  if (req.method === "GET") {
    try {
      const r = await fetch(`${apiUrl}?ref=${branch}`, { headers: ghHeaders });
      if (r.status === 404) return res.json({});
      if (!r.ok) return res.status(500).json({ error: "GitHub fetch failed", status: r.status });
      const { content } = await r.json();
      const data = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      // Get current file SHA (needed to update an existing file)
      let sha;
      const getR = await fetch(`${apiUrl}?ref=${branch}`, { headers: ghHeaders });
      if (getR.ok) {
        const current = await getR.json();
        sha = current.sha;
      }

      const content = Buffer.from(JSON.stringify(req.body, null, 2), "utf8").toString("base64");
      const body = JSON.stringify({
        message: "chore: sync study data",
        content,
        branch,
        ...(sha ? { sha } : {}),
      });

      const putR = await fetch(apiUrl, { method: "PUT", headers: ghHeaders, body });
      if (!putR.ok) {
        const err = await putR.json();
        return res.status(putR.status).json({ error: "Save failed", details: err });
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
}
