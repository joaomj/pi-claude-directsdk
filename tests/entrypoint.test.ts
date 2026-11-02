import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv, DEFAULT_ENTRYPOINT, ENTRYPOINT_ENV } from "../src/env.ts";

const build = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => buildChildEnv(env);

test("the child reports this client, replacing an inherited SDK label", () => {
  assert.equal(build({ PATH: "/bin" })["CLAUDE_CODE_ENTRYPOINT"], DEFAULT_ENTRYPOINT);
  // A Pi started from inside another Claude client must not inherit its identity.
  for (const inherited of ["sdk-ts", "sdk-cli", "cli"]) {
    assert.equal(
      build({ CLAUDE_CODE_ENTRYPOINT: inherited })["CLAUDE_CODE_ENTRYPOINT"],
      DEFAULT_ENTRYPOINT,
    );
  }
});

test("the override sets the label, and an empty override leaves the label to the CLI", () => {
  assert.equal(
    build({ [ENTRYPOINT_ENV]: "my-tool" })["CLAUDE_CODE_ENTRYPOINT"],
    "my-tool",
  );
  const unlabelled = build({ [ENTRYPOINT_ENV]: "", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in unlabelled, false);
});

test("an unusable override names the variable and the fix", () => {
  assert.throws(
    () => build({ [ENTRYPOINT_ENV]: "two words" }),
    /CLAUDE_DIRECTSDK_ENTRYPOINT must be 1-64 characters/,
  );
});
