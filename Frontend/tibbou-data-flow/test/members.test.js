import assert from "node:assert/strict";
import test from "node:test";

import { avatarIndex, filterMembers, initials, parseEmails, relativeTime, sortMembers } from "../src/lib/members.js";

test("pasted emails are split, de-duplicated and lower-cased", () => {
  assert.deepEqual(parseEmails("Ana@Example.com, bo@example.com;ana@example.com\n  not-an-email"), {
    valid: ["ana@example.com", "bo@example.com"],
    invalid: ["not-an-email"],
  });
  assert.deepEqual(parseEmails(""), { valid: [], invalid: [] });
});

test("initials come from the name, else the email", () => {
  assert.equal(initials("Ada Lovelace", "ada@x.com"), "AL");
  assert.equal(initials("", "grace.hopper@x.com"), "GH");
  assert.equal(initials(null, "kofi@x.com"), "KO");
});

test("avatar colour is stable per person", () => {
  assert.equal(avatarIndex("user-1"), avatarIndex("user-1"));
  assert.ok(avatarIndex("user-1") >= 0 && avatarIndex("user-1") < 5);
});

test("relative time reads naturally both ways", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(relativeTime("2026-10-19T12:00:00Z", now), "3 days ago");
  assert.equal(relativeTime("2026-10-27T12:00:00Z", now), "in 5 days");
  assert.equal(relativeTime("2026-10-22T11:59:30Z", now), "just now");
});

const members = [
  { user_id: "1", role: "viewer", display_name: "Zoe", email: "zoe@x.com" },
  { user_id: "2", role: "owner", display_name: null, email: "kofi@x.com" },
  { user_id: "3", role: "admin", display_name: "Ama", email: "ama@x.com" },
  { user_id: "4", role: "viewer", display_name: "Ben", email: "ben@x.com" },
];

test("members sort by role, then name", () => {
  assert.deepEqual(sortMembers(members).map((member) => member.user_id), ["2", "3", "4", "1"]);
});

test("members filter by role and search", () => {
  assert.deepEqual(filterMembers(members, { role: "viewer" }).map((member) => member.user_id), ["1", "4"]);
  assert.deepEqual(filterMembers(members, { search: "KOFI" }).map((member) => member.user_id), ["2"]);
});
