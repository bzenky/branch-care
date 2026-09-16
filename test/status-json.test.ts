import assert from "node:assert/strict";
import test from "node:test";
import type { BaseSource, RepositoryAnalysis, UpstreamState } from "../src/types.js";
import { BASE_SOURCES, UPSTREAM_STATES, formatJsonStatus, toJsonStatus } from "../src/ui/status-json.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends (<Value>() => Value extends Left ? 1 : 2) ? true : false
    : false;
type Assert<Condition extends true> = Condition;
type BaseSourceIsClosed = Assert<Equal<BaseSource, typeof BASE_SOURCES[number]>>;
type UpstreamStateIsClosed = Assert<Equal<UpstreamState, typeof UPSTREAM_STATES[number]>>;
const typeClosureEvidence: [BaseSourceIsClosed, UpstreamStateIsClosed] = [true, true];
// @ts-expect-error An unapproved base source must not compile.
const invalidBaseSource: BaseSource = "extra";
// @ts-expect-error An unapproved upstream state must not compile.
const invalidUpstreamState: UpstreamState = "extra";
void invalidBaseSource;
void invalidUpstreamState;

const analysis: RepositoryAnalysis = {
  repositoryName: "repository",
  baseBranch: "main",
  baseSource: "main",
  currentBranch: "main",
  staleAfterDays: 60,
  branches: [
    {
      name: "éclair", commitTimestamp: new Date("2025-01-01T00:00:00.000Z"), ageDays: 10, author: "É",
      upstream: "origin/éclair", upstreamState: "gone", isCurrent: false, isMerged: false,
      isStale: false, isProtected: false, isCandidate: false
    },
    {
      name: "Zebra", commitTimestamp: new Date("2025-02-01T00:00:00.000Z"), ageDays: 1, author: "Z",
      upstream: undefined, upstreamState: "none", isCurrent: false, isMerged: true,
      isStale: false, isProtected: false, isCandidate: true
    },
    {
      name: "main", commitTimestamp: new Date("2025-03-01T00:00:00.000Z"), ageDays: 0, author: "M",
      upstream: "origin/main", upstreamState: "tracking", isCurrent: true, isMerged: true,
      isStale: false, isProtected: true, isCandidate: false
    }
  ]
};

test("JSON schema version is one", () => {
  assert.equal(toJsonStatus(analysis).schemaVersion, 1);
  assert.equal(Number.isInteger(toJsonStatus(analysis).schemaVersion), true);
});

test("JSON base branch has exact shape", () => {
  const base = toJsonStatus(analysis).baseBranch;
  assert.deepEqual(Object.keys(base), ["name", "source"]);
  assert.deepEqual(base, { name: "main", source: "main" });
});

test("JSON branch has exact schema", () => {
  const expected = ["name", "lastCommitAt", "daysSinceLastCommit", "author", "upstream", "upstreamState", "isCurrent", "isMerged", "isStale", "isProtected", "isDeletionCandidate"].sort();
  for (const branch of toJsonStatus(analysis).branches) assert.deepEqual(Object.keys(branch).sort(), expected);
});

test("JSON classification booleans match shared analysis", () => {
  const document = toJsonStatus(analysis);
  for (const source of analysis.branches) {
    const json = document.branches.find(({ name }) => name === source.name);
    assert.deepEqual(
      { current: json?.isCurrent, merged: json?.isMerged, stale: json?.isStale, protected: json?.isProtected, candidate: json?.isDeletionCandidate },
      { current: source.isCurrent, merged: source.isMerged, stale: source.isStale, protected: source.isProtected, candidate: source.isCandidate }
    );
  }
});

test("JSON branches use bytewise order", () => {
  const reordered = { ...analysis, branches: [...analysis.branches, { ...analysis.branches[0]!, name: "alpha" }] };
  assert.deepEqual(toJsonStatus(reordered).branches.map(({ name }) => name), ["Zebra", "alpha", "main", "éclair"]);
});

test("JSON enums contain exactly approved members", () => {
  assert.deepEqual(typeClosureEvidence, [true, true]);
  assert.deepEqual(BASE_SOURCES, ["cli", "repository", "originHead", "main", "master", "develop"]);
  assert.deepEqual(UPSTREAM_STATES, ["none", "tracking", "gone"]);
  for (const source of BASE_SOURCES) assert.equal(JSON.parse(formatJsonStatus({ ...analysis, baseSource: source })).baseBranch.source, source);
  for (const upstreamState of UPSTREAM_STATES) {
    const upstream = upstreamState === "none" ? undefined : "origin/topic";
    const branch = { ...analysis.branches[0]!, upstream, upstreamState };
    assert.equal(JSON.parse(formatJsonStatus({ ...analysis, branches: [branch] })).branches[0].upstreamState, upstreamState);
  }
});
