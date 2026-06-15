/** Updates the GitHub Actions workflow run display title, if running inside GHA. */
export async function updateGhaRunTitle(title: string): Promise<void> {
  const { GITHUB_RUN_ID, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY || !GITHUB_TOKEN) return;

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ display_title: title }),
      },
    );
    if (!resp.ok) {
      console.warn(`Warning: failed to update GHA run title (HTTP ${resp.status})`);
    }
  } catch (e) {
    console.warn(`Warning: failed to update GHA run title: ${e}`);
  }
}
