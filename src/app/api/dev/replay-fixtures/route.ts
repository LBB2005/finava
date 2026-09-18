/**
 * Dev only: serves the SSE fixtures in evals/fixtures/sse to the chat replay
 * bench (/dev/chat-replay). 404 in production, like the dev-auth bypass.
 *
 *   GET ?            → { fixtures: [{ name, route, recorded }] }
 *   GET ?name=<name> → { name, sse (base64), expected, timing }
 *
 * Recorded fixtures carry their `.timing.json` sidecar; the synthetic ones get
 * a steady default pace.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultTiming, type ReplayTiming } from "@/lib/chatBench/timing";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

function fixtureDir(): string {
  return path.join(process.cwd(), "evals", "fixtures", "sse");
}

function fixtureNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sse"))
    .map((f) => f.slice(0, -".sse".length))
    .sort();
}

export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return notFound();
  const dir = fixtureDir();
  const names = fixtureNames(dir);
  const name = new URL(req.url).searchParams.get("name");

  if (!name) {
    return Response.json({
      fixtures: names.map((n) => ({
        name: n,
        route: n.replace(/^recorded-/, "").startsWith("agent-") ? "/api/agent" : "/api/chat",
        recorded: existsSync(path.join(dir, `${n}.timing.json`)),
      })),
    });
  }
  // Only a name from the listing: never a path built from the query.
  if (!names.includes(name)) return notFound();

  const bytes = new Uint8Array(readFileSync(path.join(dir, `${name}.sse`)));
  const timingFile = path.join(dir, `${name}.timing.json`);
  const timing: ReplayTiming = existsSync(timingFile)
    ? (JSON.parse(readFileSync(timingFile, "utf8")) as ReplayTiming)
    : defaultTiming(name, bytes);
  return Response.json({
    name,
    sse: Buffer.from(bytes).toString("base64"),
    expected: readFileSync(path.join(dir, `${name}.expected.md`), "utf8"),
    timing,
  });
}
