import type { Env } from "../../env.js";
import type { TrackMetrics } from "../../core/track-metrics.js";
import { formatHaiku, kmToMi, mToFt } from "../../core/units.js";

const RETRY_DELAYS_MS = [1000, 4000, 16000] as const;
const MAX_SLUG_COLLISION_ATTEMPTS = 10;

export interface PublishPostArgs {
  title: string;
  haiku: string;
  body: string;
  lat?: number;
  lon?: number;
  placeName?: string;
  weather?: string;
  env: Env;
  /** Injectable for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: () => Date;
}

export interface PublishPostResult {
  url: string;
  path: string;
  sha: string;
}

export class PublishError extends Error {
  public readonly status: number;
  constructor(opts: { status: number; message: string }) {
    super(opts.message);
    this.name = "PublishError";
    this.status = opts.status;
  }
}

interface ContentsApiPutResponse {
  content: { sha: string; path: string; html_url: string };
  commit: { sha: string };
}

interface ContentsApiErrorBody {
  message?: string;
}

interface ResolvedPublishPath {
  yyyy: string;
  mm: string;
  dd: string;
  slug: string;
  path: string;
  url: string;
}

/**
 * Derive the dated path + slug + public URL for a post. Shared across all
 * three publish callers (publishPost, publishTrackPost, publishPostWithImage)
 * — they differ in render shape and commit mechanism, but the slug-and-path
 * derivation is identical.
 *
 * The caller resolves `now` (request time for !post / postimg; closedAt for
 * track) before calling. Keeps this helper pure.
 */
async function resolvePublishPath(args: {
  env: Env;
  title: string;
  now: Date;
}): Promise<ResolvedPublishPath> {
  const yyyy = String(args.now.getUTCFullYear());
  const mm = pad2(args.now.getUTCMonth() + 1);
  const dd = pad2(args.now.getUTCDate());

  const baseSlug = slugify(args.title, args.now);
  const { path, slug } = await findFreePath(args.env, args.env.JOURNAL_POST_PATH_TEMPLATE, {
    yyyy,
    mm,
    dd,
    baseSlug,
  });

  const url = renderUrl(args.env.JOURNAL_URL_TEMPLATE, { yyyy, mm, dd, slug });
  return { yyyy, mm, dd, slug, path, url };
}

/**
 * Contents-API PUT publish path shared by `publishPost` and `publishTrackPost`.
 * Resolves the path, calls `renderFn` to produce the markdown (variant-specific
 * frontmatter), commits via Contents API PUT (with retry on 5xx).
 *
 * `publishPostWithImage` uses a different commit mechanism (atomic GraphQL
 * `createCommitOnBranch`) and shares only `resolvePublishPath`.
 *
 * Auth: fine-grained PAT in `GITHUB_JOURNAL_TOKEN` scoped to exactly the
 * journal repo (`contents:write`). 4xx surfaces immediately (auth/perm bug —
 * retrying won't help). 5xx retries 1 s / 4 s / 16 s.
 */
async function publishMarkdown(args: {
  env: Env;
  title: string;
  now: Date;
  delay: (ms: number) => Promise<void>;
  renderFn: (resolved: ResolvedPublishPath) => string;
}): Promise<PublishPostResult> {
  const resolved = await resolvePublishPath({ env: args.env, title: args.title, now: args.now });
  const markdown = args.renderFn(resolved);
  const putResp = await putContents(args.env, resolved.path, markdown, args.title, args.delay);
  return { url: resolved.url, path: resolved.path, sha: putResp.commit.sha };
}

/**
 * Commit one markdown file per `!post` to the dedicated journal repo via the
 * GitHub Contents API. Public URL is derived from `JOURNAL_URL_TEMPLATE`
 * (P1-04) so reply links survive a Jekyll/Hugo theme swap.
 *
 * Slug is derived from the narrative title (lowercase ASCII alphanumerics
 * plus hyphens, ≤ 50 chars). On the rare same-minute collision we GET the
 * candidate path; on 200 we increment a `-2`, `-3`, … suffix until 404.
 *
 * Frontmatter shape (Jekyll/Hugo compatible). `location:` and `weather:`
 * keys are omitted when their inputs are absent — no `(0, 0)` placeholders.
 */
export async function publishPost(args: PublishPostArgs): Promise<PublishPostResult> {
  const { title, haiku, body, lat, lon, placeName, weather, env } = args;
  const now = (args.now ?? (() => new Date()))();
  const delay = args.delay ?? defaultDelay;

  return publishMarkdown({
    env,
    title,
    now,
    delay,
    renderFn: () =>
      renderMarkdown({
        title,
        haiku,
        body,
        date: now.toISOString(),
        lat,
        lon,
        placeName,
        weather,
      }),
  });
}

/**
 * Public for tests — slug derivation. Returns at most 50 lowercase
 * alphanumeric/hyphen chars; fallback `untitled-HHMMSS` when title strips
 * empty.
 */
export function slugify(title: string, fallbackNow: Date): string {
  const stripped = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  let slug = stripped;
  if (slug.length > 50) {
    slug = slug.slice(0, 50).replace(/-+$/, "");
  }
  if (slug.length === 0) {
    slug = `untitled-${pad2(fallbackNow.getUTCHours())}${pad2(fallbackNow.getUTCMinutes())}${pad2(fallbackNow.getUTCSeconds())}`;
  }
  return slug;
}

async function findFreePath(
  env: Env,
  template: string,
  parts: { yyyy: string; mm: string; dd: string; baseSlug: string },
): Promise<{ path: string; slug: string }> {
  for (let i = 0; i < MAX_SLUG_COLLISION_ATTEMPTS; i += 1) {
    const slug = i === 0 ? parts.baseSlug : `${parts.baseSlug}-${i + 1}`;
    const path = template
      .replaceAll("{yyyy}", parts.yyyy)
      .replaceAll("{mm}", parts.mm)
      .replaceAll("{dd}", parts.dd)
      .replaceAll("{slug}", slug);

    const exists = await contentsExists(env, path);
    if (!exists) return { path, slug };
  }
  throw new PublishError({
    status: 0,
    message: `slug collision: tried ${MAX_SLUG_COLLISION_ATTEMPTS} variants of "${parts.baseSlug}"`,
  });
}

async function contentsExists(env: Env, path: string): Promise<boolean> {
  const url = `https://api.github.com/repos/${env.GITHUB_JOURNAL_REPO}/contents/${encodePath(path)}?ref=${env.GITHUB_JOURNAL_BRANCH}`;
  const res = await fetch(url, { method: "GET", headers: githubHeaders(env) });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  // Auth or other error — surface so caller sees real problem rather than
  // looping into a slug-collision dance.
  const message = await readErrorMessage(res);
  throw new PublishError({ status: res.status, message: `GET contents: ${message}` });
}

async function putContents(
  env: Env,
  path: string,
  markdown: string,
  title: string,
  delay: (ms: number) => Promise<void>,
): Promise<ContentsApiPutResponse> {
  const url = `https://api.github.com/repos/${env.GITHUB_JOURNAL_REPO}/contents/${encodePath(path)}`;
  const init: RequestInit = {
    method: "PUT",
    headers: githubHeaders(env),
    body: JSON.stringify({
      message: `trailscribe: ${title}`,
      content: base64Utf8(markdown),
      branch: env.GITHUB_JOURNAL_BRANCH,
    }),
  };

  let lastErr: PublishError | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]);

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = new PublishError({
        status: 0,
        message: `network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (res.ok) {
      return (await res.json()) as ContentsApiPutResponse;
    }

    const message = await readErrorMessage(res);
    const err = new PublishError({ status: res.status, message: `PUT contents: ${message}` });

    if (res.status >= 400 && res.status < 500) throw err;
    lastErr = err;
  }

  throw lastErr ?? new PublishError({ status: 0, message: "publish failed without a captured error" });
}

function githubHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_JOURNAL_TOKEN}`,
    "User-Agent": "trailscribe",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

interface RenderArgs {
  title: string;
  haiku: string;
  body: string;
  date: string;
  lat?: number;
  lon?: number;
  placeName?: string;
  weather?: string;
}

function renderMarkdown(a: RenderArgs): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${quoteYaml(a.title)}`);
  lines.push(`date: ${a.date}`);
  if (a.lat !== undefined && a.lon !== undefined) {
    const place = a.placeName !== undefined ? `, place: ${quoteYaml(a.placeName)}` : "";
    lines.push(`location: { lat: ${a.lat}, lon: ${a.lon}${place} }`);
  }
  if (a.weather !== undefined) {
    lines.push(`weather: ${quoteYaml(a.weather)}`);
  }
  lines.push("tags: [trailscribe]");
  lines.push("---");
  lines.push(formatHaiku(a.haiku));
  lines.push("");
  lines.push(a.body);
  return lines.join("\n");
}

function renderUrl(template: string, parts: { yyyy: string; mm: string; dd: string; slug: string }): string {
  return template
    .replaceAll("{yyyy}", parts.yyyy)
    .replaceAll("{mm}", parts.mm)
    .replaceAll("{dd}", parts.dd)
    .replaceAll("{slug}", parts.slug);
}

function quoteYaml(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Encode each path segment, leaving slashes intact. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** UTF-8 → base64 (Workers' btoa only accepts Latin-1; need explicit byte path). */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** ArrayBuffer → base64 (binary path; same Latin-1 trick as base64Utf8). */
function base64Bytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface PublishPostWithImageArgs extends PublishPostArgs {
  image: {
    bytes: ArrayBuffer;
    mimeType: string;
    /** Path template applied with the same slug as the post. */
    pathTemplate: string;
  };
}

export interface PublishPostWithImageResult extends PublishPostResult {
  imagePath: string;
  commitOid: string;
}

interface GraphqlCommitData {
  data?: {
    createCommitOnBranch?: {
      commit?: { oid: string; url: string };
    };
  };
  errors?: Array<{ message: string }>;
}

interface GraphqlBranchOidData {
  data?: {
    repository?: {
      ref?: { target?: { oid: string } };
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Atomic markdown + image commit via GitHub's GraphQL `createCommitOnBranch`
 * mutation (P2-18). The two `additions` land in a single commit, so an
 * interrupted run cannot leave a markdown post pointing at a missing image.
 *
 * Public URL derivation, slug collision handling, and frontmatter shape are
 * inherited from `publishPost` — this function calls into the same helpers
 * and adds an `image:` frontmatter key plus a leading `![title](/path)`
 * markdown line so the rendered Pages site shows the image at the top.
 */
export async function publishPostWithImage(
  args: PublishPostWithImageArgs,
): Promise<PublishPostWithImageResult> {
  const { title, haiku, body, lat, lon, placeName, weather, env, image } = args;
  const now = (args.now ?? (() => new Date()))();

  const resolved = await resolvePublishPath({ env, title, now });

  const ext = extensionForMime(image.mimeType);
  const imagePath = image.pathTemplate
    .replaceAll("{yyyy}", resolved.yyyy)
    .replaceAll("{mm}", resolved.mm)
    .replaceAll("{dd}", resolved.dd)
    .replaceAll("{slug}", resolved.slug)
    .replaceAll("{ext}", ext);

  const markdown = renderMarkdownWithImage({
    title,
    haiku,
    body,
    date: now.toISOString(),
    lat,
    lon,
    placeName,
    weather,
    imagePath,
    baseurl: env.JOURNAL_BASEURL,
  });

  const [owner, repo] = splitRepo(env.GITHUB_JOURNAL_REPO);
  const branch = env.GITHUB_JOURNAL_BRANCH;

  const expectedHeadOid = await fetchBranchOid(env, owner, repo, branch);

  const mutationVars = {
    input: {
      branch: { repositoryNameWithOwner: env.GITHUB_JOURNAL_REPO, branchName: branch },
      message: { headline: `trailscribe: ${title}` },
      expectedHeadOid,
      fileChanges: {
        additions: [
          { path: resolved.path, contents: base64Utf8(markdown) },
          { path: imagePath, contents: base64Bytes(image.bytes) },
        ],
      },
    },
  };

  const mutation = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: githubHeaders(env),
    body: JSON.stringify({ query: mutation, variables: mutationVars }),
  });

  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new PublishError({
      status: res.status,
      message: `GraphQL createCommitOnBranch HTTP ${res.status}: ${message}`,
    });
  }

  const json = (await res.json()) as GraphqlCommitData;
  if (json.errors && json.errors.length > 0) {
    throw new PublishError({
      status: 0,
      message: `GraphQL createCommitOnBranch errors: ${json.errors.map((e) => e.message).join("; ")}`,
    });
  }
  const commit = json.data?.createCommitOnBranch?.commit;
  if (!commit) {
    throw new PublishError({
      status: 0,
      message: "GraphQL createCommitOnBranch returned no commit",
    });
  }

  return {
    url: resolved.url,
    path: resolved.path,
    sha: commit.oid,
    imagePath,
    commitOid: commit.oid,
  };
}

async function fetchBranchOid(
  env: Env,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const query = `query ($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $branch) {
      target { ... on Commit { oid } }
    }
  }
}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: githubHeaders(env),
    body: JSON.stringify({
      query,
      variables: { owner, repo, branch: `refs/heads/${branch}` },
    }),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new PublishError({
      status: res.status,
      message: `GraphQL branch oid HTTP ${res.status}: ${message}`,
    });
  }
  const json = (await res.json()) as GraphqlBranchOidData;
  const oid = json.data?.repository?.ref?.target?.oid;
  if (!oid) {
    throw new PublishError({
      status: 0,
      message: `GraphQL branch oid: branch '${branch}' not found on ${owner}/${repo}`,
    });
  }
  return oid;
}

function splitRepo(nameWithOwner: string): [string, string] {
  const [owner, repo] = nameWithOwner.split("/");
  if (!owner || !repo) {
    throw new PublishError({
      status: 0,
      message: `GITHUB_JOURNAL_REPO must be 'owner/repo', got '${nameWithOwner}'`,
    });
  }
  return [owner, repo];
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function extensionForMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "img";
}

interface RenderArgsWithImage extends RenderArgs {
  imagePath: string;
  baseurl: string;
}

function renderMarkdownWithImage(a: RenderArgsWithImage): string {
  const imageUrl = `${stripTrailingSlash(a.baseurl)}/${a.imagePath}`;
  const lines: string[] = ["---"];
  lines.push(`title: ${quoteYaml(a.title)}`);
  lines.push(`date: ${a.date}`);
  lines.push(`image: ${imageUrl}`);
  if (a.lat !== undefined && a.lon !== undefined) {
    const place = a.placeName !== undefined ? `, place: ${quoteYaml(a.placeName)}` : "";
    lines.push(`location: { lat: ${a.lat}, lon: ${a.lon}${place} }`);
  }
  if (a.weather !== undefined) {
    lines.push(`weather: ${quoteYaml(a.weather)}`);
  }
  lines.push("tags: [trailscribe]");
  lines.push("---");
  lines.push(`![${a.title}](${imageUrl})`);
  lines.push("");
  lines.push(formatHaiku(a.haiku));
  lines.push("");
  lines.push(a.body);
  return lines.join("\n");
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ContentsApiErrorBody;
    return body.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export interface PublishTrackPostArgs {
  title: string;
  haiku: string;
  body: string;
  metrics: TrackMetrics;
  endLat: number;
  endLon: number;
  startPlace?: string;
  endPlace?: string;
  weather?: string;
  env: Env;
  /** Injectable for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to `new Date(metrics.closedAt)`. */
  now?: () => Date;
}

/**
 * Track-flavored publish. Same Contents API PUT path as publishPost, but the
 * frontmatter is the track shape (type: track + nested track block) and the
 * dated path uses the session's closedAt timestamp.
 */
export async function publishTrackPost(args: PublishTrackPostArgs): Promise<PublishPostResult> {
  const { title, haiku, body, metrics, endLat, endLon, startPlace, endPlace, weather, env } = args;
  const now = (args.now ?? (() => new Date(metrics.closedAt)))();
  const delay = args.delay ?? defaultDelay;

  return publishMarkdown({
    env,
    title,
    now,
    delay,
    renderFn: () =>
      renderTrackMarkdown({
        title,
        haiku,
        body,
        metrics,
        endLat,
        endLon,
        startPlace,
        endPlace,
        weather,
      }),
  });
}

function renderTrackMarkdown(a: {
  title: string;
  haiku: string;
  body: string;
  metrics: TrackMetrics;
  endLat: number;
  endLon: number;
  startPlace?: string;
  endPlace?: string;
  weather?: string;
}): string {
  const m = a.metrics;
  const lines: string[] = ["---"];
  lines.push(`title: ${quoteYaml(a.title)}`);
  lines.push(`date: ${new Date(m.closedAt).toISOString()}`);
  lines.push(`type: track`);
  lines.push(`track:`);
  lines.push(`  started_at: ${new Date(m.startedAt).toISOString()}`);
  lines.push(`  duration_seconds: ${m.durationSeconds}`);
  lines.push(`  distance_mi: ${kmToMi(m.distanceKm).toFixed(2)}`);
  lines.push(`  elevation_gain_ft: ${Math.round(mToFt(m.elevation.gainM))}`);
  lines.push(`  activity_hint: ${m.activityHint}`);
  lines.push(`  route_shape: ${m.routeShape}`);
  if (a.startPlace !== undefined && a.startPlace !== "") {
    lines.push(`  start_place: ${quoteYaml(a.startPlace)}`);
  }
  if (a.endPlace !== undefined && a.endPlace !== "") {
    lines.push(`  end_place: ${quoteYaml(a.endPlace)}`);
  }
  lines.push(`  pings: ${m.pingCount}`);
  lines.push(`  close_reason: stop`);
  const place = a.endPlace !== undefined ? `, place: ${quoteYaml(a.endPlace)}` : "";
  lines.push(`location: { lat: ${a.endLat}, lon: ${a.endLon}${place} }`);
  if (a.weather !== undefined) lines.push(`weather: ${quoteYaml(a.weather)}`);
  lines.push(`tags: [trailscribe, track]`);
  lines.push("---");
  lines.push(formatHaiku(a.haiku));
  lines.push("");
  lines.push(a.body);
  return lines.join("\n");
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
