/**
 * The HTTP client the golden-transcript tooling talks to a RUNNING judge
 * with. Deliberately thin: a transcript is only worth replaying if the
 * request went over the wire exactly as `wmoj-app` would send it —
 * `X-Judge-Token`, a JSON body, nothing else.
 *
 * `JUDGE_URL` defaults to the port the container publishes; the shared
 * secret has no default, because a judge running with `AUTH_STRICT=false`
 * would otherwise answer an unauthenticated capture and bake a transcript
 * nobody can reproduce under production settings.
 */

const DEFAULT_JUDGE_URL = "http://localhost:4001";

/** One exchange with the judge: the status line and the decoded body. */
export interface Exchange {
  status: number;
  /**
   * The parsed JSON body, or the raw text when the response was not JSON
   * — the judge has no 404 handler and no error middleware, so an
   * unmatched path answers with Express's default HTML and a transcript
   * of that is still worth recording.
   */
  body: unknown;
}

export function judgeUrl(): string {
  const url = process.env.JUDGE_URL;
  return url !== undefined && url.length > 0 ? url : DEFAULT_JUDGE_URL;
}

function sharedSecret(): string {
  const secret = process.env.JUDGE_SHARED_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw new Error(
      "JUDGE_SHARED_SECRET is not set — the judge's only gate is that token, " +
        "so capture and replay must both send it (see run-judge-locally)",
    );
  }
  return secret;
}

async function decode(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * What to do when the judge refuses with its rate limit. 60 requests per
 * minute per `(ip, token)` covers BOTH gated routes and, with one token,
 * all of wmoj-app shares the bucket — so one capture plus one replay
 * inside the same window collide even though either alone fits. Neither
 * tool records or compares such a response: a 429 is the judge declining
 * to answer, not an answer.
 */
export const RATE_LIMIT_ADVICE =
  "the judge rate-limits 60 requests/min per token across both gated routes — " +
  "wait for the window to roll over, or start the container with -e RATE_LIMIT_MAX=1000";

export function isRateLimited(exchange: Exchange): boolean {
  return exchange.status === 429;
}

/** POST a JSON body to one of the two gated endpoints. */
export async function post(endpoint: string, body: unknown): Promise<Exchange> {
  const response = await fetch(`${judgeUrl()}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Judge-Token": sharedSecret(),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await decode(response) };
}

/**
 * `GET /health` — unauthenticated by design. Returns the body whatever the
 * status is: a `503 {status:"degraded"}` is exactly what a replay needs to
 * see before it decides the judge is worth talking to.
 */
export async function health(): Promise<Exchange> {
  const response = await fetch(`${judgeUrl()}/health`);
  return { status: response.status, body: await decode(response) };
}
