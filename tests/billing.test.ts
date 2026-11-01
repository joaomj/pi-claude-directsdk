import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOW_USAGE_CREDITS_ENV,
  usageCreditsAllowed,
  usageCreditsChargeError,
  usageCreditsRejectionError,
} from "../src/billing.ts";

test("usage credits are opt-in", () => {
  assert.equal(usageCreditsAllowed({}), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "0" }), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "off" }), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "1" }), true);
});

test("a usage-credit rejection is an actionable, non-retryable billing error", () => {
  const rejection = usageCreditsRejectionError(
    "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
  );
  assert.ok(rejection);
  assert.match(rejection.message, /^Claude Code billing:/);
  assert.equal(rejection.kind, "billing");
  assert.equal(usageCreditsRejectionError("overloaded"), undefined);
});

test("a reported overage names the charge, the reset, and the opt-in", () => {
  const error = usageCreditsChargeError({
    status: "allowed_warning",
    rateLimitType: "five_hour",
    resetsAt: 1_800_000_000,
    isUsingOverage: true,
  });
  assert.match(error.message, /charged to Claude usage credits/);
  assert.match(error.message, /2027-01-15/);
  assert.match(error.message, new RegExp(`${ALLOW_USAGE_CREDITS_ENV}=1`));
  // A charge that already happened cannot be undone; say so.
  assert.match(error.message, /cannot|undo|further requests are not charged/);
  assert.equal(error.kind, "billing");
});

test("an ordinary reply that mentions billing is not a provider failure", () => {
  // Classification uses provider signals, never the model's own words.
  assert.equal(
    usageCreditsRejectionError("Here is how to read a billing error message."),
    undefined,
  );
});
